---
name: devteam
description: cmux マルチペイン開発チーム (main worker Claude / supervisor Claude / codex reviewer) を束ねて操作するスキル。bootstrap / relay / review / status / ask / report の主要サブコマンドを持つ。ユーザーが「/devteam」「devteam relay」「devteam review」「メインどうなった」「codex に review 投げて」等を言ったときに supervisor 側でトリガー。また main Claude が人間判断を仰ぎたい時 (`/devteam ask "..."`) や step 完了を知らせたい時 (`/devteam report "..."`) もトリガー。main から supervisor に `[main→supervisor]` で始まる入力が cmux send で届いた時は supervisor の受信ルールに従って動く。
agents: [claude]
---

# devteam

cmux マルチペイン開発チームのオーケストレーション。

## 前提構造

同じ workspace に 3 ペイン:

| 役割           | 特徴                                                       |
| -------------- | ---------------------------------------------------------- |
| **main**       | "Claude Code" タイトルの他ペイン (自分ではない方)          |
| **supervisor** | このスキルを実行している Claude ペイン (`◀ here` マーカー) |
| **reviewer**   | codex (title に `Claude Code` が付かない terminal ペイン)  |

`cmux tree` でこの 3 役を毎回自動判別する。surface ID は session ごとに変わるので固定化しない。

## 運用モード / 自動化ポリシー

**原則**: user 認証が必要な不可逆操作以外は supervisor が自動で回す。main 完了 → codex review → needs-changes なら main に差し戻し → 再 review → approve まで全部自動進行。途中報告は 1 行レベルで user に流す。

**user GO が必要なもの** (ここで停止して明示指示を待つ):
- `git commit` 実行 (ユーザー明示 GO 待ち。勝手にコミットしない)
- 本番デプロイ (`harness/devteam.local.md` の deploy-commands 節に列挙された不可逆コマンド。
  local.md 不在なら deploy / push --force / merge / publish 等のキーワードで保守的に GO 待ち)
- prod backfill / prod DB 書き換え / 外部通知 (Slack / email / webhook 発火)
- 方針分岐で user の判断が必要なケース (main からの `[main→supervisor] ask` 経由)
- その他 destructive / shared-state を変更する操作 (force push / branch 削除 / リリース作成 等)

**自動で進めるもの**:
- main 完了報告を検知 → 差分 bundle 作成 → `/devteam review` 相当で codex に dispatch
- codex review 完了 → `cmux read-screen` で結果回収 + 要約
- verdict = needs-changes → P1/P2 finding + regression test 要求を main に relay
- verdict = approve → user に「commit しますか?」だけ聞いて止まる (commit 自体は GO 待ち)
- test 実行 / plan doc 更新 / bootstrap 不足 pane の起動提案

**沈黙回避**: user が応答しない間も stuck せず進められる step は進め、stuck したら `/devteam ask` で明示問い合わせ。auto mode でも auth 境界は越えない。

## superpowers writing-plans からの handoff (受け取り側)

`brainstorming` → `writing-plans` で spec + plan が完成した直後、supervisor は
**superpowers の execution choice prompt (Subagent-Driven / Inline) を両方 skip**
して devteam mode に入り、main pane に Task 1 から順次 relay する。本 repo の handoff
default (詳細は `harness/devteam.local.md` の rule-refs 節、実装 phase handoff の正本ルール)。

### Handoff 発動 trigger

writing-plans が以下のような prompt を出した直後:

> Plan complete and saved to `docs/superpowers/plans/<filename>.md`. Two execution options: 1. Subagent-Driven (recommended) 2. Inline Execution. Which approach?

→ supervisor は **どちらも選ばず devteam mode に切替**。user に 1 行報告:

> Plan を読んで Task 1 から main pane に relay します (cmux 利用なので superpowers built-in execution は skip、rule は local.md の rule-refs)。

### 受け取り側手順 (per task)

1. **plan.md から Task N の本文を抽出** (Read tool で plan.md を read、Task N の `### Task N` から次 task または 区切り `---` までを切り出す)
2. **`/tmp/devteam_relay_<topic>-r<N>.md` に落とす** (heredoc、長文 transport pattern):
   ```bash
   cat > /tmp/devteam_relay_<topic>-r${N}.md <<'EOF'
   # [supervisor→main] Task ${N}: <title> (${topic})

   <Task N の本文をそのまま貼る>

   ## Commit / report 規約
   - TDD step (失敗 test → 実装 → 緑確認 → commit) を順守
   - commit message は plan.md の sample 通り
   - 完了したら /devteam report "Task ${N} 完了 — <要約>" で supervisor に push
   - 詰まったら /devteam ask "<question>" で supervisor 経由 user に問う
   EOF
   ```
3. **main pane に 1 行 send** (prefix + path 参照 + 目的要約):
   ```bash
   cmux send --surface <main_surface> "[supervisor→main] /tmp/devteam_relay_<topic>-r${N}.md を Read tool で全文読み、Task ${N} を実装してください。完了したら /devteam report で push handoff してください。"
   cmux send-key --surface <main_surface> return
   ```
4. **`run_in_background: true` で Monitor 起動** (main の report を catch するため、本 SKILL「Primary: `run_in_background` Bash Monitor」節を使う):
   ```bash
   # main pane の scrollback で `[main→supervisor] report:` を anchor に検知
   ```
5. **report 受信** → 本 SKILL 「(supervisor 側) report 受信時の動き」節に従う:
   - commit を `git log feat/<sub-branch> -1` で確認
   - codex review が必要な規模なら `/devteam review <topic>` 相当を dispatch
   - approve → 次 Task (`r<N+1>`) を Step 1 に戻って relay
   - needs-changes → 修正指示を `/tmp/devteam_relay_<topic>-r<N>-fix.md` に落として relay (round 2 まで、3 round 上限は本 SKILL「再 review ループ上限」節に従う)
6. **Sub-PR 完了 = 全 Task 完了**: integration branch (local.md rule-refs) に sub-PR を `gh pr create --base feat/<topic>-integration` で open、user merge を待つ
7. **Sub-PR merge 後**: integration branch を pull → 次 sub-PR の最初の Task に進む
8. **全 sub-PR 着地後**: 最終 integration PR を `gh pr create --base main` で open、`Closes #<issue>` で auto-close 設定

### plan.md の Task が relay file に "そのまま"乗らないケース

Task が極端に長い (300 行超) / 複数 phase をまたぐ:
- 1 Task を **複数 round に分割**して relay (例: Task 5 を `r5a`, `r5b` の 2 file に切る)
- main に「Task 5 の前半のみ実装、完了 report を返したら後半を relay する」と明示
- supervisor 側で plan.md 内 progress を memory (TodoWrite 等) で管理

### handoff を skip する fallback

- **cmux 不在** (cloud routine 等): superpowers `subagent-driven-development` を使う (本 SKILL は不要)
- **trivial plan (1-2 task / 全 commit < 100 LOC)**: handoff overhead > plan 規模なので supervisor 自身が inline で `executing-plans` を invoke (本 SKILL は skip)

## サブコマンド

| コマンド                      | 用途                                                              | 実行する Claude |
| ----------------------------- | ----------------------------------------------------------------- | --------------- |
| `/devteam` (引数なし)         | 未指定時は **status** 扱い (pane 不足時は bootstrap を提案)       | supervisor      |
| `/devteam bootstrap`          | 3 ペイン揃ってるか確認、不足分は GO 確認後に自動で split + 起動   | supervisor      |
| `/devteam relay`              | main の最新状態を読み取り、ユーザーに要約 + 選択肢提示            | supervisor      |
| `/devteam review <topic>`     | 現在の git diff を codex reviewer に投げて結果回収                | supervisor      |
| `/devteam status`             | 3 ペインの役割割当と現在状態を 1 画面で表示                       | supervisor      |
| `/devteam ask "<question>"`   | 人間の判断を仰ぎたい時 supervisor 経由で問いかける                | **main**        |
| `/devteam report "<summary>"` | task step 完了時に supervisor へ非ブロッキング通知 (push handoff) | **main**        |

## 共通: 役割自動判別

毎回最初に実行して surface ID を特定する:

```bash
cmux tree
```

判別ルール (supervisor ペインで実行する前提):
- **supervisor** = `◀ here` が付いている surface
- **main** = 同じ workspace 内の `"[] Claude Code"` タイトルを持つ他 surface
- **reviewer** = 同じ workspace 内で title に `Claude Code` が付かない terminal surface (通常 codex)

複数候補あるときは `[selected]` または最初にマッチしたもの。見つからないときは該当役割なしとしてユーザーに報告。

## 共通: ペイン間メッセージ prefix 規約

cmux send で pane 越しにメッセージを送るとき、**発信元と宛先を prefix で明示する**。受信側が user 入力との区別、ログ追跡、ask/report の自動分岐をやりやすくなる。

| 方向                          | prefix              | 用途                                                                                |
| ----------------------------- | ------------------- | ----------------------------------------------------------------------------------- |
| main → supervisor             | `[main→supervisor]` | ask / report の発信 (`[main→supervisor] ask ...` / `[main→supervisor] report: ...`) |
| supervisor → main             | `[supervisor→main]` | 差し戻し指示 / user 返答の relay / 状態通知                                         |
| supervisor → reviewer (codex) | **prefix なし**     | codex は prefix 規約を知らないので素のプロンプトで送る                              |
| reviewer → supervisor         | **prefix なし**     | codex 出力は `cmux read-screen` で supervisor が直接読み取る (send back しない)     |

**supervisor → main の典型例**:
```bash
cmux send --surface <main> "[supervisor→main] codex review 結果: needs-changes。以下修正してください ..."
cmux send-key --surface <main> return
```

**原則**:
- supervisor ↔ main 間は双方向で prefix 必須 (逆向きが無いと ask/report 誤検知や user 入力との混同が起きる)
- reviewer (codex) との往復は prefix なし
- prefix の後に半角スペース 1 つ、その後にメッセージ本文

## 共通: supervisor 側 async 運用 (Claude Code の場合)

supervisor が Claude Code エージェントとして動いている場合、Monitor ループを
**foreground Bash で 30 分張る**と Claude が 2 分 timeout で返って来るか
文脈をブロックする。しかし Claude Code の `Bash` tool には
**`run_in_background: true`** があり、これを使えば Monitor を in-session
background として真に async 実行できる。**これが primary な async 手段**。

### Primary: `run_in_background` Bash Monitor (session 内 codex review 用)

review dispatch 直後、同 session 内で completion 検知したい場合は
**必ず `run_in_background: true` で Monitor を起動する**。process は
Claude の他操作と並行で走り、VERDICT 検知で `exit 0` した時点で
Claude に **auto-notification** が届く。supervisor は検知瞬間に
verdict 確認 + 次 action に進める (ScheduleWakeup による polling 不要、
user の手動通知不要)。

呼び出し方 (**script file 化推奨**):

monitor logic を `Bash(command: '...')` に inline で書くと awk の `$0` (positional 変数) が shell escape で消失し、`awk: bailing out / syntax error / context is >>>  ~ <<<` で 30 分 silent 走行→ timeout death の事故が起きる (過去 dogfood で実証)。**必ず `/tmp` に script file を落として bash 経由で起動** する。

##### Step 1: monitor script を /tmp に書き出す (4-layer guard 全部入り)

```bash
cat > /tmp/devteam_monitor_codex_<topic>-r<N>.sh <<'EOF'
#!/bin/bash
# 4-layer guard:
# Layer 1: DISPATCH_MARKER anchor (sed slice、scrollback の古い verdict 除外)
# Layer 2: response-area scope (• prefix 以降のみ、prompt echo の literal example 除外)
# Layer 3: EOL-anchored VERDICT 単独行 regex (自然文中の verdict mention 除外)
# Layer 4: Token usage fallback (verdict 行欠落時に stuck 回避)

DISPATCH_MARKER="codex_<topic>-r<N>.md"
REVIEWER="<reviewer_surface>"

for _ in $(seq 1 90); do  # 最大 30 min (20s × 90)
  out=$(cmux read-screen --surface "$REVIEWER" --scrollback 2>/dev/null)

  # Layer 1: slice from DISPATCH_MARKER to end
  after_marker=$(echo "$out" | sed -n "/$DISPATCH_MARKER/,\$p")

  # Layer 2: keep only response-area lines (after first "• " bullet)
  resp=$(echo "$after_marker" | awk '/^• / {f=1} f {print}')

  # Layer 3: EOL-anchored VERDICT line
  if echo "$resp" | grep -qE "^[[:space:]]*VERDICT: (approve|needs-changes)[[:space:]]*$"; then
    v=$(echo "$resp" | grep -oE "VERDICT: (approve|needs-changes)" | tail -1)
    echo "REVIEW_DONE: $v"
    exit 0
  fi

  # Layer 4: Token usage fallback
  if echo "$resp" | grep -qE "Token usage: total="; then
    echo "REVIEW_DONE_NO_VERDICT"
    exit 0
  fi

  sleep 20
done

echo "REVIEW_TIMEOUT: 30min elapsed"
exit 2
EOF
chmod +x /tmp/devteam_monitor_codex_<topic>-r<N>.sh
```

##### Step 1.5: script 存在を確認してから Step 2 を出す (parallel tool-call race 防御)

Step 1 (script 書き出し + chmod) と Step 2 (run_in_background 起動) は **必ず別の tool-call message で sequential に出す**。同 message の parallel tool-call で投げると、harness が Step 1 の結果を反映する前に Step 2 の `run_in_background: true` を評価して `Running a monitor script that hasn't been written in this transcript` で deny される race がある (過去 dogfood で実発生)。

簡易確認は 1 行で十分:

```bash
ls -la /tmp/devteam_monitor_codex_<topic>-r<N>.sh
```

存在 + 実行 bit (`-rwx`) を確認したら Step 2 へ。Write tool 経由で script を落とす流儀でも race 条件は同じなので、本 SKILL の `cat > /tmp/...` 経由でも同様に sequential を守る。

##### Step 2: run_in_background で script を起動

```
Bash(
  command: 'bash /tmp/devteam_monitor_codex_<topic>-r<N>.sh',
  run_in_background: true
)
```

##### Step 3: 起動直後の sanity check (推奨、finding #6 防御)

`run_in_background` の output file (`Output is being written to: <path>`) を **monitor 起動から数秒以内に 1 回 tail** し、awk / sed の syntax error が出ていないか確認する。VERDICT / Token usage は出る前に sleep が走るので **empty output が正常**、`awk:` / `sed:` で始まる error が出ていれば script 自体を直してから再起動。これにより silent 30 min 死亡を bootstrap 段階で検知できる。

**重要**:
- `run_in_background: true` **必須**。foreground で回すと Claude が
  ブロックされて他 tool を呼べない
- Monitor 起動後 supervisor は他作業 (user への 1 行報告など) を続けて OK
- Monitor が exit した時点で Claude は自動で notification を受け、出力
  (`REVIEW_DONE: ...`) を読み取って verdict 判定に進む
- sleep は probe 1 回あたり 20s、total 30 min (90 iterations)。途中で
  user 発話など中断要因が入れば、supervisor が手動で kill してもよい
- **4-layer guard を 1 つでも省略しない**: 過去 dogfood で
  Layer 2 (response-area scope) を省略 → prompt echo の literal `VERDICT:
  needs-changes` 例示行を false positive で catch、codex がまだ Working
  中なのに verdict 検知してしまう事故が起きた (finding #7)

### Fallback: 1-shot probe + ScheduleWakeup (cross-session / 長期待ち用)

review 節の Monitor ループ本体 1 iteration 分を `/tmp/devteam_probe_<topic>.sh`
に落として **1 shot 化**し、`ScheduleWakeup` (Claude Code harness が提供する
delayed re-entry 機構) でポーリング tick として再 fire する。

- tick 間隔: **270s** (prompt cache 窓 5 min 以内を選ぶ。300s は cache miss
  との worst-of-both なので避ける)
- 30 分上限に達したら user に相談 (再 review ループ上限の節参照)

probe の典型構造:

```bash
#!/bin/bash
DISPATCH_MARKER="codex_<topic>-r<N>.md"   # round 区別のため suffix 必須 (下記)
REVIEWER="<reviewer_surface>"

out=$(cmux read-screen --surface "$REVIEWER" --scrollback 2>/dev/null)
resp=$(echo "$out" | awk -v m="$DISPATCH_MARKER" '
  $0 ~ m {found_marker=1; next}
  found_marker && /^• / {in_response=1}
  in_response {print}
')

if echo "$resp" | grep -qE "^[[:space:]]*VERDICT: (approve|needs-changes)[[:space:]]*$"; then
  v=$(echo "$resp" | grep -oE "VERDICT: (approve|needs-changes)" | tail -1)
  echo "REVIEW_DONE: $v"
  exit 0
fi
if echo "$resp" | grep -qE "Token usage: total="; then
  echo "REVIEW_DONE_NO_VERDICT"
  exit 0
fi
echo "STILL_RUNNING"
exit 1
```

### Wakeup prompt は anchor metadata 付き (stale 検知)

`ScheduleWakeup` の prompt は **予約時点の文字列が fire 時に literal 実行
される** (動的書き換え不可)。予約と fire の間に state が進むと prompt は
stale になる。prompt 冒頭に anchor metadata を必ず埋める:

```
[wakeup anchor: round=<N>, dispatch_marker=codex_<topic>-r<N>.md, ts=<ISO8601>]

fire 時の手順 (必ずこの順):
1. cmux read-screen --surface <reviewer> --scrollback で現状確認
2. scrollback 内に **anchor より新しい round の DISPATCH_MARKER** があれば
   → stale 判定、no-op で終了。user に 1 行 "stale wakeup skip (round N+k 進行中)" 報告
3. なければ anchor round の probe 本体を実行
```

### Round 区別は DISPATCH_MARKER の suffix で

同じ topic で複数 round 走るとき、diff file を `/tmp/codex_<topic>.md`
固定にすると round 間で scrollback 上に同じ marker が並び、「Round 2 以降
に進んだか」判定が曖昧になる。**round suffix を必ず付ける**:

```
Round 1: /tmp/codex_<topic>-r1.md
Round 2: /tmp/codex_<topic>-r2.md
...
```

stale 判定 (上記 step 2) は単純に scrollback を
`grep "codex_<topic>-r[0-9]+\.md"` して最大 round を取るだけ。

### 重複 fire の dedup

短時間に複数 wakeup が積まれた / 予約タイミングが重なったケースで、
probe 本体が二重走行しないよう先頭で lock:

```bash
LOCK="/tmp/devteam-wakeup-lock-r<N>.txt"
if [ -f "$LOCK" ] && [ -n "$(find "$LOCK" -mmin -1 2>/dev/null)" ]; then
  # 1 分以内に別 fire が処理中 → skip
  exit 0
fi
touch "$LOCK"
# ... probe 本体 ...
rm -f "$LOCK"
```

lock 古い (mtime > 1 min) なら先の fire が死んでるので自分が引き継ぐ。

### Monitor 優先度 (Round 衝突時)

現 Round N の Monitor / probe と、**Round N-k の stale wakeup** が同時に
fire した場合:

- **最新 round が優先** (scrollback 上に存在する最大 round の DISPATCH_MARKER が正)
- 古い round の wakeup は stale として no-op + 1 行 user 報告

この判定は wakeup prompt の anchor ステップ 2 で拾う。

### Probe script は round 不変、DISPATCH_MARKER を環境変数化

`/tmp/devteam_probe_<topic>.sh` は **round 間で上書き不要**。script 本体
を round-agnostic にし、呼び出し側から `DISPATCH_MARKER` と `LOCK` を
環境変数で渡す:

```bash
# 呼び出し側 (wakeup prompt 内か手動 trigger)
DISPATCH_MARKER="codex_<topic>-r2.md" \
LOCK="/tmp/devteam-wakeup-lock-r2.txt" \
  bash /tmp/devteam_probe_<topic>.sh
```

これで script の編集ミス / Round 2 で古い marker を拾う事故を防ぐ。

### Tick 数の上限計算

`270s` tick で 30 分上限 (review 節の Monitor 規約) なら **6 tick**
(270 × 6 = 1620s ≒ 27 分) で user 相談に倒す。7 tick 目 (1890s) を
走らせると 30 分超なので 6 回で止めるのが安全。

### Anchor 欠落 wakeup の fail-safe

古い session から残った wakeup が anchor metadata 無しで fire した場合、
prompt を literal に解釈しない。**無条件で no-op + user に
「anchor 欠落 wakeup skip、手動で `/devteam status` を」と 1 行報告**。
曖昧解釈で二重実行する方が risk が高い (review 節 `REVIEW_DONE_NO_VERDICT`
の「曖昧なケースは必ず user 確認に落とす」精神)。

### Stale 判定時の git state 補助

DISPATCH_MARKER scan (scrollback) で stale が確定できない微妙なケース
では、`git log --oneline origin/HEAD..HEAD` で unpushed commits を見て
「Round 2 以降の fix commit が積まれてるか」を補助判定に使える。git
信号は scrollback より保存寿命が長い。

### `REVIEW_DONE_NO_VERDICT` fallback の P1/P2 抽出 hint

codex は指摘を通常 `P1:` / `P2:` / `[P1]` / `**P1**` のいずれかの
書式で書く。fallback 時は:

```bash
p1_count=$(echo "$body" | grep -cEi "(^|\[|\*\*)P1[:\]\*]")
p2_count=$(echo "$body" | grep -cEi "(^|\[|\*\*)P2[:\]\*]")
```

を目安に使い、review 節の 3 分岐テーブル (auto needs-changes /
auto approve / user 確認) に流す。完璧な regex は不要、**曖昧なら
user 確認に倒す**。

## 共通: supervisor → main の長文 transport (file 経由)

`cmux send` は改行が通らず (注意事項節参照)、2000 字級の日本語 / shell
code 混在を一度に送ると main 側 display / scrollback で欠落することが
ある。長文 relay は **reviewer 向けの `/tmp/codex_<topic>-r<N>.md`
pattern を supervisor→main 方向に流用** して解決する。

### Path 命名規約

| 用途                              | path                                                |
| --------------------------------- | --------------------------------------------------- |
| supervisor → reviewer (codex)     | `/tmp/codex_<topic>-r<N>.md`                        |
| supervisor → main (差し戻し / 長文指示) | `/tmp/devteam_relay_<topic>-r<N>.md`            |

round suffix は round 区別のため必須 (前述 "async 運用" 節と同じ理由)。

### 送信は短い 1 行 + path 参照

長文本体を `/tmp/devteam_relay_<topic>-r<N>.md` に heredoc で落とし、
`cmux send` には **短い 1 行** (prefix + path 参照 + 目的要約) だけ
置く:

```bash
cat > /tmp/devteam_relay_<topic>-r${N}.md <<'EOF'
# [supervisor→main] needs-changes 差し戻し (Round ${N})

## Fix 1 (P2-1): <タイトル>
<背景 + patch 例 10-20 行>
## Fix 2 (P2-2): ...
## Fix 3 (P3-1): ...

## Commit 戦略
- amend 禁止、新規 commit を積む
- commit message: `fix(<scope>): ... (round ${N})`
- 完了で /devteam report、push / merge は user GO 待ち
EOF

cmux send --surface <main_surface> "[supervisor→main] codex review round ${N}: needs-changes。詳細は /tmp/devteam_relay_<topic>-r${N}.md に置きました。Read tool で全文読み、Fix 1/2/3 を順に実装してください。完了後は /devteam report で push handoff してください。"
cmux send-key --surface <main_surface> return
```

### Prefix 配置ルール

`[supervisor→main]` / `[main→supervisor]` は **cmux send の 1 行本文に
置く**。file 内に書いても main に届く send の prefix にはならない
(前述 prefix 規約節の「pane 間の送受信単位で成立」を踏襲)。

分割送信 (戦略 fallback) のときも **各 chunk 先頭に prefix** を必ず
付ける。連番は `1/N`, `cont. N/M` のような裁量記法でよい。

### Main 側 read 手順

送信本文に「Read tool で `<path>` を全文読んで実行してください」を
明示する。reviewer 向け dispatch の `Please read /tmp/...` (review 節)
の同パターン。main が Claude Code なら Read tool で file を開けば
truncation ゼロで届く。

### Truncation 検知とリカバリ

送信直後に main snapshot:

```bash
cmux read-screen --surface <main_surface> | tail -30
```

- 送信文の末尾 (path 文字列 / 句読点) が途中で切れてる → truncation
- `[supervisor→main]` prefix が main の受信表示に出てない → 欠落
- 全然別の内容に進んでる → 受信失敗

リカバリ 3 段 (simple → aggressive):

1. **再送**: 同じ 1 行 `cmux send` + `send-key return` をもう 1 回
2. **短縮**: 要約文を削り `[supervisor→main] <path> を読んで実行`
   だけに縮める
3. **最小**: path だけに削る。`[supervisor→main] /tmp/devteam_relay_...md`
   (path は truncate されないレベルまで)

それでも届かないなら分割送信 (file 中身を 2-4 chunk に割って順送)、
最後の手段として user に「main が受信できない」を 1 行報告して相談。

### File lifecycle

`/tmp/devteam_relay_<topic>-r<N>.md` は session 内では残す (main が
再読込したいときに参照できる)。session 終了で OS 側が /tmp を掃除する
前提。明示的な削除は不要。

## サブコマンド実装

### bootstrap

`/devteam` (status 含む) 実行時に main / reviewer のいずれかが不在なら、**ユーザーに一言確認してから supervisor 側で自動的に pane を split + コマンド起動する**。

標準レイアウト (supervisor から見て):
- **main** = `new-split right` で右に開いて `claude` 起動
- **reviewer** = `new-split down` で下に開いて `codex` 起動

手順:

1. `cmux tree` で 3 役を判別
2. 不在役割をユーザーに提示し 1 回だけ GO 確認 (「起動しますか？」)
3. GO が出たら supervisor の workspace に対して実行:

```bash
# main が不在なら
cmux new-split right --workspace <supervisor_workspace>   # → 新しい surface:N を返す
cmux send --surface <new_surface> "claude"
cmux send-key --surface <new_surface> return

# reviewer が不在なら
cmux new-split down --workspace <supervisor_workspace>
cmux send --surface <new_surface> "codex"
cmux send-key --surface <new_surface> return
```

4. 5 秒ほど待って `cmux tree` + `cmux read-screen --surface <new_surface> | tail -20` で起動確認
   - main: `Claude Code v...` バナーが出れば OK
   - reviewer: `OpenAI Codex (v...)` バナーが出れば OK
5. supervisor 自身は必ず存在する前提 (これを実行してるから)
6. **role marker file 書込み** (任意: Stop hook auto-notify 用。hook 未設定でもスキル自体は動く):

```bash
# 各役割の surface id を対応する marker file に書く
# (colon は dash に置換: surface:33 → cmux-role-surface-33.txt)
write_marker() {
  local sid="$1" role="$2"
  local safe=$(printf '%s' "$sid" | tr ':/ ' '---')
  echo "$role" > "/tmp/cmux-role-${safe}.txt"
}
write_marker <supervisor_surface> supervisor
write_marker <main_surface> main
write_marker <reviewer_surface> reviewer
```

ユーザー側で `~/.claude/hooks/devteam-main-stop.sh` 等の Stop hook を用意しておけば、main pane 停止時に marker を見て role=main を検知し supervisor に `[main→supervisor] stopped (auto)` を自動通知できる。supervisor / reviewer は marker が "main" でないので no-op。hook がなければ通知は来ないが、`/devteam relay` / `/devteam status` で手動確認は可能。

**どちらか片方だけ不在のケース** もあり得る。その場合は不在分だけ split する。レイアウトの好みをユーザーが指定 (右/下/上/左) したらそれに従う。

**ユーザー GO なしで split はしない** (誤操作による workspace レイアウト破壊を防ぐため、1 回だけでも明示確認を取る)。

### relay

main の現状を user と相談できる形にする。

```bash
# 1. main pane 特定
cmux tree
# 2. 末尾読み取り
cmux read-screen --surface <main_surface> | tail -80
```

読み取り内容から state を分類:
- **waiting_for_go**: `GO?` `許可` `進めますか` `OK なら` 等の質問終端
- **running**: `Monitor started` / `Cogitated` / Bash 実行中など、進行中
- **error**: `Error:` `Denied` `failed`
- **completed**: 最後に要約表やチェックリストが出ていてプロンプトが戻っている
- **idle**: 上記いずれも該当せず、最後のユーザー入力待ちプロンプト

ユーザーに提示する形:

```
## main Claude 状態: <state>

<main の最後の質問 or 実行中タスク要約>

<state=waiting_for_go のときは選択肢>
- GO: そのまま進める
- 却下: やめさせる
- 修正: こういう条件で再実行して
- 追加情報: <不足情報>
```

relay 後の動き (自動化ポリシー準拠):
- main が `waiting_for_go` で、次のアクションが **commit / deploy 等 user GO 必須**なら → user に提示して止まる
- 上記以外 (review dispatch / 修正差し戻し / 次 step 着手 / test 走らせる 等) → supervisor 判断で即送信、1 行 status で user に報告
- ユーザーの返答が来たら `cmux send --surface <main_surface> "..."` + `cmux send-key --surface <main_surface> return` で relay

### review

git diff を codex reviewer に投げる。

```bash
# 1. topic 引数を取得、なければ "review" を default
TOPIC="${1:-review}"
# 再 review (Round 2+) なら round を明示。初回は 1
ROUND="${ROUND:-1}"
# 2. 差分書き出し (範囲は状況依存、デフォは uncommitted + unpushed)
#    round suffix で Round 間の区別を確実にする (詳細: 前述 "async 運用" 節)
{
  echo "# ${TOPIC} review request (Round ${ROUND})"
  echo "## unpushed commits"
  git log --oneline origin/HEAD..HEAD 2>/dev/null || git log --oneline -5
  echo ""
  echo "## unpushed diff"
  git diff origin/HEAD..HEAD 2>/dev/null
  echo ""
  echo "## uncommitted"
  git diff HEAD
} > /tmp/codex_${TOPIC}-r${ROUND}.md

# 3. reviewer pane 特定 (cmux tree)
# 4. 送信 — 最終行に verdict を **単独行** で出すよう厳格に指示する
cmux send --surface <reviewer_surface> "Please read /tmp/codex_${TOPIC}.md and review the changes. Reply in Japanese. Focus: correctness, security, race conditions, edge cases.

出力末尾の要件 (厳守):
- 最終行は必ず以下のいずれかを **単独行** (前後に他の文字なし) で出力:
  VERDICT: approve
  または
  VERDICT: needs-changes
- 'approve' / 'needs-changes' のどちらか 1 つだけ。理由や解説を同じ行に書かない。
- 要約や追記は VERDICT 行より前に置く。VERDICT 行の後に何も書かない。"
cmux send-key --surface <reviewer_surface> return

# 5. 完了待機
# Monitor で VERDICT 行 or codex 終端シグナル "Token usage: total=" 検知 (下記)
```

**dispatch prompt の verdict 指示の注意**:
- `approve or needs-changes` のような or で繋いだ書き方は **prompt 自身が monitor regex と collision する**。prompt 内には必ず `VERDICT: approve` / `VERDICT: needs-changes` の **両方を別々に** 書き、「どちらか単独で」と明示する。
- `Final verdict:` キーワードは dispatch prompt の中でもユーザー向け出力 (要約) の中でも登場しやすいため、Monitor と衝突させたくない独自 token (`VERDICT:`) を使う。codex は素直にこの token を使ってくれる。

**review 完了の auto-catch (必須)**: codex には Stop hook 相当が無いので、supervisor が Monitor でバックグラウンド watch を立てて完了 signal を取りにいく。review dispatch 直後に必ず実行:

> **supervisor が Claude Code の場合**、以下の while ループは **`run_in_background: true` で Bash tool 起動** すると session 内 async として動き、VERDICT 検知で `exit 0` した瞬間に Claude へ auto-notification が届く。これが primary パターン。詳細は上述「共通: supervisor 側 async 運用 (Claude Code の場合)」節の Primary 節を参照。cross-session にまたがる長期待ちなら同節の Fallback (1-shot probe + ScheduleWakeup) を使う。shell / shellscript supervisor では下記ループをそのまま foreground で使ってよい。

```bash
# Monitor は以下を兼ねる:
#   a) "VERDICT: approve" / "VERDICT: needs-changes" が **単独行** で出た時 → 正常完了
#   b) codex 終端 "Token usage: total=" が出たのに (a) が無い時 → verdict-missing として
#      emit し、supervisor が本文から手動 infer する (fail-open)
# どちらも **dispatch 後の出力** だけを対象にする (古い review の残骸を拾わないため)
```

Monitor の command イメージ (4 重 guard):
```bash
# DISPATCH_MARKER: 今回の review dispatch を anchor する固有の文字列。
# 通常 /tmp/codex_${TOPIC}.md のパス自体が session 内ユニーク。
DISPATCH_MARKER="codex_${TOPIC}.md"

while true; do
  out=$(cmux read-screen --surface <reviewer_surface> --scrollback 2>/dev/null)

  # 1) DISPATCH_MARKER 以降、かつ **codex response area** だけを切り出す。
  #    codex の response は "• " で始まる bullet 行から開始する。
  #    prompt echo 部 (指示文に書いた literal "VERDICT: approve" 例示行) を
  #    scan 対象から除外する必須ステップ。
  resp=$(echo "$out" | awk -v m="$DISPATCH_MARKER" '
    \$0 ~ m {found_marker=1; next}
    found_marker && /^• / {in_response=1}
    in_response {print}
  ')

  # 2) VERDICT 行 (単独行) を探す — EOL anchored
  if echo "\$resp" | grep -qE "^[[:space:]]*VERDICT: (approve|needs-changes)[[:space:]]*$"; then
    v=\$(echo "\$resp" | grep -oE "VERDICT: (approve|needs-changes)" | tail -1)
    echo "REVIEW_DONE: \$v"
    exit 0
  fi

  # 3) fallback: codex の終端シグナル "Token usage: total=" が出た (= review 完了) が
  #    VERDICT 行が無い → verdict 出し忘れ。supervisor に手動 infer を求める
  if echo "\$resp" | grep -qE "Token usage: total="; then
    echo "REVIEW_DONE_NO_VERDICT: codex finished without VERDICT line"
    exit 0
  fi

  sleep 20
done
```

**Monitor の 4 層 guard を全部入れる理由** (1 つでも抜けると誤検知):

| #   | guard                           | 防ぐ誤検知                                                                                               |
| --- | ------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 1   | DISPATCH_MARKER anchor          | **別セッションの review 結果** を拾う (scrollback に残る過去の `VERDICT:` / `Final verdict:`)            |
| 2   | response-area scope (`• ` 以降) | **prompt echo** 内の literal token 例示行 (`    VERDICT: approve` / `    VERDICT: needs-changes`) を拾う |
| 3   | EOL anchored regex              | **自然文中の verdict mention** (prose で "VERDICT: approve と書いて" 等) を拾う                          |
| 4   | `Token usage:` fallback         | codex が verdict 行を忘れたまま閉じた → **stuck せずに手動 infer に切替え**                              |

タイムアウト 1800s (30 min)。通知受けたら:

```bash
cmux read-screen --surface <reviewer_surface> --scrollback \
  | awk -v m="codex_${TOPIC}.md" '$0 ~ m {found=1} found{print}' \
  | tail -300
```

で該当 review の本文だけを回収 → supervisor が verdict を要約提示。

**`REVIEW_DONE_NO_VERDICT` のとき** (infer 閾値を厳格に):

本文から P1/P2 件数 + 締めの文言を読み、下記 3 分岐で判定する。**曖昧なケースは必ず user 確認に落とす** (自動進行の誤判定コストが高いため)。

| 分岐                   | 条件                                                                                                 | アクション                                                                                                                                             |
| ---------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **auto needs-changes** | P1 ≥ 1 **or** 「承認前に」「修正後」「ブロック」等の修正要求文言を明確に含む                         | user 確認なしで `needs-changes` 相当として main に差し戻し (regression test 要求を含める)                                                              |
| **auto approve**       | P1 = 0 **かつ** P2 = 0 **かつ**「重大な問題は見つけていません」「LGTM」等の明確な approve 文言を含む | 「commit しますか?」を user に提示して停止                                                                                                             |
| **user 確認**          | 上記いずれにも該当しない (P1=0 & P2≥1 / 締め文言曖昧 / 承認とも否定ともつかない)                     | supervisor は勝手に verdict 決めず、user に本文要約 + 「needs-changes として差し戻しますか? approve として commit に進みますか?」の 2 択を提示して停止 |

**どの分岐でも**、dispatch prompt の VERDICT 指示が守られなかったこと自体を user に 1 行報告する (繰り返すようなら skill / prompt 側の改善余地)。

**判定の具体例**:
- 本文「P1 × 2、締め: 承認前に P1 を入れたい」→ auto needs-changes (迷いなし、差し戻し)
- 本文「P1=0、P2 × 2 (nit レベル)、締めなし」→ **user 確認** (P2 のみは approve 寄りだが曖昧なので決めない)
- 本文「P1=0、P2=0、締め: LGTM」→ auto approve (commit GO 確認へ)

同時に dispatch prompt の VERDICT 指示を厳守しなかったこと自体を user に 1 行報告 (繰り返すようなら skill / prompt 側の改善余地)。

**忘れがちな注意**: Monitor を立て忘れると user が「review 終わったよ」と言うまで supervisor が気付けない。review dispatch と Monitor セットは **1 つの操作として扱う**。

**古い verdict の誤検知防止**: scrollback には過去 review の `VERDICT:` / `Final verdict:` がそのまま残る。Monitor は **必ず DISPATCH_MARKER 以降に anchor** して scan する。tail -50 のような末尾固定スライスだけでは不十分 (user が中間に何か入力すると位置がズレる)。

**review 完了後の自動進行** (自動化ポリシー準拠):
- verdict = **needs-changes** → finding を P1/P2 別に整理し、**即 main に差し戻し** (`cmux send --surface <main>` で修正指示 + regression test 要求)。user の確認は取らない (supervisor 判断)
- verdict = **approve** → 「commit しますか?」を user に提示して停止。commit 自体は user GO 待ち
- 修正後の再 review も supervisor 判断で自動 dispatch、approve になるまで (max 3 周程度、それ以上なら user に相談)

### verdict 要約時の scope 外 surface rule (verification-surface rule hook)

repo 側で `.claude/rules/workflow.md` に「Verification で発見した scope 外 bug の
surface ルール」等の相当 rule が定義されている場合 (repo 側に該当 rule があれば。`harness/devteam.local.md` の rule-refs 参照)、codex review
の本文に以下の signal が混ざっていたら **verdict とは別の Markdown heading
(`## Follow-up 候補 (scope 外)` 等) を立てて** supervisor summary に surface する。
verdict 本文の末尾箇条書き / 括弧書き / インライン caveat は "独立" と見なさない:

- `"pre-existing"`, `"別問題"`, `"out-of-scope"`, `"本 PR 対象外"`, `"separate bug"`
- `"既存の ... 依存"`, `"未整備"`, `"blocker は別"`
- `"既知"`, `"known issue"`, `"既知の制約"`, `"別途対応"`, `"TODO"`, `"scope 外"`,
  `"この PR では扱わない"`

最低限 surface する 3 点 (rule 原文と同じ):

1. **発見した事象** (何が起きたか — 事実)
2. **推定影響** (blocker / 別 scope / 波及先 — 主観と明記)
3. **follow-up issue 化するか?** (user への問いかけ)

**urgency 境界**: 通常は summary 列挙で user の pull-based 判断に任せる。ただし
**follow-up の urgency が高い (blocker 波及 / prod 影響あり / 次 session 開始を
遅らせるべき)** と推定したら `/devteam ask` フローに push して止まる (軽量な
未整備・footgun は summary 列挙のみで OK)。

**signal 0 件のとき**: 「今回 scope 外 surface 候補なし」と明記する (空欄禁止、
空欄だと "skip" と "漏れ" が区別できなくなるため)。

**適用する repo 側 rule が無い場合**: この hook は skip OK (signal 検知も不要)。

### ask (main 側で実行)

main Claude が「ユーザー (人間) の判断が必要」と判断したときに使う。supervisor ペインに問いを投げて、main は返答待機に入る。

1. `cmux tree` で supervisor pane を検出 (`◀ here` は **自分の pane なので除外**、同一 workspace の他 "Claude Code" pane)
2. 質問本文を supervisor に送る:

```bash
cmux send --surface <supervisor_surface> "[main→supervisor] <question>"
cmux send-key --surface <supervisor_surface> return
```

3. 送信後 main はユーザー返答待ち状態で待機。追加の prompt が来るまで新しい実行はしない (supervisor から `cmux send --surface <main>` で答えが返ってくる)

**使うべき場面**:
- 本番デプロイ / prod DB 書き換え / 外部通知など不可逆/高リスク操作の GO 確認
- 方針分岐が複数あり判断が必要なとき
- エラー発生時に継続/中断の判断が欲しいとき

**使うべきでない場面**:
- ちょっとした確認 (それは main 側で判断する)
- 実装の技術的 detail (codex review に回すべき)

### (supervisor 側) ask 受信時の動き

main から `[main→supervisor] ...` で始まる input が届いたら supervisor は:

1. 人間ユーザーに「main が問いかけてきました」と要約提示 + 選択肢
2. ユーザーの返答を受け取る
3. main pane に `cmux send --surface <main> "<ユーザー返答>"` + return で中継

supervisor は main への返答を勝手に生成しない。必ず人間の回答を待つ。

### report (main 側で実行) — push handoff

main Claude が「1 つの task step が終わって次の指示待ち」になったときに使う。**ask と違い非ブロッキング**。supervisor が自動的に次の step を進める判断材料になる。

1. `cmux tree` で supervisor pane 検出 (◀ here を **除く** 同一 workspace の他 Claude Code pane)
2. 通知送信:

```bash
cmux send --surface <supervisor_surface> "[main→supervisor] report: <3 行以内のサマリ、完了 step、test 結果、次候補>"
cmux send-key --surface <supervisor_surface> return
```

3. 送信後 main は追加 prompt を待つ状態で待機 (ask と同じ)

**使うべき場面**:
- 実装 step の区切り (1 タスク完了時 / 中間マイルストーン到達時)
- 全テスト緑まで到達したとき
- 自分だけでは判断できない分岐に来たとき (ask 寄りだがブロックが軽い case)

**使うべきでない場面**:
- 途中の tool 実行結果 (うるさい)
- 内部推論の節目 (skip)

#### ⚠️ PR open 前に supervisor の最新 verdict を確認

cadence B で main は「Task 完了 → 次 step (= PR open) を自律進行」する設計。一方
supervisor は **非同期** で codex verdict を待つので、両者の clock は独立。main が
`gh pr create` を打つ前に、直近 step の review verdict が **approve 済** かつ
未解消の needs-changes が無いことを確認する:

- 確認手段: 直前の supervisor relay を読む / `/devteam report "Task N 完了、PR
  open 可否を確認"` で 1 度 push して GO を待つ
- これを欠くと obsolete / in-flight verdict に基づく PR open が走る (過去 session で
  main の「PR opened」 report と supervisor の R2 verdict relay が cross した
  実例)
- single-main / review 不要な trivial PR ではこの確認は skip OK (verdict 待ちが
  存在しないため)

### (supervisor 側) report 受信時の動き

main から `[main→supervisor] report: ...` を受け取ったら supervisor は:

1. `cmux read-screen --surface <main> | tail -100` で詳細 state 回収
2. 自動化ポリシーに従って次アクション判定:
   - review dispatch する step なら → 自動で `/devteam review` 相当を実行
   - needs-changes で差し戻し中に修正完了報告なら → 再 review dispatch
   - commit/deploy 相当の境界なら → user に「commit しますか?」で停止
   - 判断に迷う / 仕様分岐なら → user に状況 + 選択肢を提示
3. **report 本文に scope 外 surface signal が含まれていたら** verification-surface
   rule hook を適用 (下記「scope 外 surface signal の扱い」参照) — 本節の動きは
   verdict 要約時と同じ、独立 heading で user summary に surface する
4. user には 1-2 行で状況+次アクションを報告 ("main が task 完了報告 → codex review に自動 dispatch した" 等)

ask と異なり user 返答を待たずに supervisor 自身が進める。auth 境界に当たったら停止。

#### scope 外 surface signal の扱い

main の report 本文 / `cmux read-screen` で拾った state に scope 外 signal が
混ざっていたら、verdict 要約時と同じ hook を適用する。**signal list / 3 点の
surface 項目 / urgency 境界 / 0 件時の挙動は上述「verdict 要約時の scope 外
surface rule (verification-surface rule hook)」節が single source**。本節は
trigger (verdict vs report) が違うだけで挙動は同一。

要点のみ再掲:
- 独立 heading (`## Follow-up 候補 (scope 外)`) で surface、括弧書き禁止
- urgency 高推定 → `/devteam ask` に push
- 該当 rule 無い環境では skip OK

signal list を iterate するときは必ず上述節側を編集 (本節は pointer only)。

### status

1 画面サマリ:

```
## devteam status

### main (surface:X / pane:Y)
state: <waiting_for_go | running | error | completed | idle>
last activity: <最後の意味ある 1 行>

### supervisor (surface:13 / here)
state: active (このセッション)

### reviewer (surface:Z / pane:W)
state: <idle | working | last-reviewed>
```

## Multi-main mode (Phase 1, dogfood)

> multi-main mode。既存 single-main flow は無変更で動く (alias なし `[main→supervisor]` は m1 として扱う後方互換)。

### 概要

- main pane を **同 workspace 内に最大 3 個まで** 並列配置 (m1 / m2 / m3)
- 各 main は専用 worktree (`<worktree-prefix>-<alias>`) で git collision 回避
- supervisor は **alias 付き prefix** (`[supervisor→main:m1]` / `[main:m2→supervisor]`) で routing
- reviewer は 1 つのまま (FIFO queue で順次 dispatch)

### Use case

- **A. Different-issue parallel**: m1 が issue A、m2 が issue B を並行 fix。supervisor は両者の report を独立に受けて reviewer に順次 dispatch
- **B. Same-issue multi-view**: 1 issue に対して m1 と m2 が独立に approach (例: 違う実装案を並行検討)、supervisor / user が後で pick
- **C. Backup main**: m1 が context 詰まりかけたら m2 を立ち上げて切替 (segregation of context)

### main alias map

bootstrap 時に supervisor 内 in-memory map を構築:

```
{
  "m1": { surface: "surface:3", workspace: "workspace:1", worktree: "<worktree-prefix>-m1" },
  "m2": { surface: "surface:5", workspace: "workspace:1", worktree: "<worktree-prefix>-m2" },
  "m3": { surface: "surface:7", workspace: "workspace:1", worktree: "<worktree-prefix>-m3" },
}
```

session ephemeral、bootstrap で再構築。alias は `m1` から連番。

### Prefix scheme (alias 付き)

| 方向 | 拡張形 | 後方互換 |
|---|---|---|
| main → supervisor | `[main:m1→supervisor] ...` | `[main→supervisor]` を `m1` 扱い (single-main session 救済) |
| supervisor → main | `[supervisor→main:m1] ...` | `[supervisor→main]` (alias なし) は **broadcast 禁止**、必ず明示 alias |

supervisor → main は **broadcast 禁止** (誤って全 main に同じ指示が飛ぶと scope 混乱)。main → supervisor の後方互換は、bootstrap 時点で multi-main mode に入っていない session を壊さない救済 (m1 1 つだけしか居ないなら alias 省略 OK)。

### relay file 命名 (alias suffix 必須)

```
/tmp/devteam_relay_<topic>-r<N>-<main_alias>.md
```

例:
- `/tmp/devteam_relay_<issueA>-fixture-r1-m1.md` (m1 が issue A を担当)
- `/tmp/devteam_relay_<issueB>-r1-m2.md` (m2 が issue B を担当)

同 topic で複数 main 並走しても衝突しない。alias を path に literal で含むので、supervisor の stale lookup でも main を即特定可能。

### Worktree 分離 (git collision 防止)

#### Scope 判定 table (過去 dogfood reflection)

worktree 分離は **異 issue / 異 PR 並走** の git collision 防止が本来意義。
**同 PR 内 task split** は worktree を作らず 1 worktree shared で turn-take する
方が cherry-pick chain が消えて effort が下がる (cycle 2 dogfood で 6 回
cherry-pick / file 命名衝突 / fixture schema drift 連鎖の 3 件発生、 retro
過去 dogfood の reflection)。

| scope | pattern | bootstrap 経路 |
|---|---|---|
| **異 issue / 異 PR の並行 fix** | worktree 分離 + 別 branch (Phase 1 spec 通り) | `bootstrap multi N` + 各 main 用 `-b <branch>` で worktree 作成 |
| **同 PR 内 task split で 作業 path が分かれる** (例: m1=`backend/src/` のみ / m2=`backend/tests/` のみ) | **1 worktree shared + 1 branch + file-level turn-take** (worktree 不要) | `bootstrap multi N` を **使わない**、 single-main session で path-divided な 2 main を file lock で coord (下記 「Same-PR task split protocol」 参照) |
| **同 PR 内 task split で 作業 path が混じる** (例: 同 file を 2 main が触る) | single-main 連続実行 (multi-main 過剰) | 通常 single-main、 turn-take せず 1 main で順次 |

**判定 trigger**: bootstrap 前に supervisor が 「これから 2 main が触る path /
作成する file 名」 を briefing draft の段階で確認。 path が main 別に物理分離
できれば same-PR-split path、 そうでなければ別 PR 並走 / single-main を選ぶ。

#### Same-PR task split protocol (1 worktree shared)

worktree を作らず、 **1 worktree (project root or 既存 worktree) を 2 main が
共有** する場合の coord rule:

- **ファイル別 lock**: 各 main は briefing で literal に列挙された path 集合
  にのみ書込む。 m1 の write path と m2 の write path は **集合が disjoint**
  (重なり 0)
- **branch は 1 本**: m1 が先行 commit、 m2 は m1 の commit を `git fetch +
  rebase` で取り込んでから自分の change を commit (turn-take)。 m2 の
  rebase は user GO 不要 (devteam handoff flow 中の self-rebase は OK、
  ただし `--force-with-lease` push が要るなら user GO 必須)
- **共通 file (test fixture / config / 別 main も読む module)** は 1 main が
  primary owner、 もう 1 main は read-only 扱い。 primary owner が edit 終わっ
  たら commit + push、 secondary main は次の turn で git pull
- supervisor は relay 時に **「m1 が触る path リスト」 「m2 が触る path リスト」
  を briefing literal に明示**、 main 側で自分の write set を縛る

#### bootstrap 時に各 main 用 worktree を作成 (異 PR 並走時のみ)

**`superpowers:using-git-worktrees` skill を内部呼出し** (重複実装しない):

```bash
# 各 main の専用 branch を同時に切る (-b 必須)
git worktree add -b fix/<N>-<topic> <worktree-prefix>-m1 main
git worktree add -b harness/<topic> <worktree-prefix>-m2 main
```

**`-b <branch>` は省略不可** (過去 dogfood で確定): `main` branch は project root で既に checkout 済なので、`git worktree add <worktree-prefix>-m1 main` (branch 指定なし) は **`fatal: 'main' is already used by worktree at ...`** で fail する。各 main 用に **専用 branch を `-b` で同時に作成** することで衝突を回避し、main pane が即 task に着手できる。

各 main pane は起動直後に `cd <worktree-prefix>-<alias>` で自 worktree に移動。各 main は独立 branch (`fix/<N>-...`) を切れる (上記 `-b` で既に切られている)。

teardown: `git worktree remove <worktree-prefix>-<alias>` を user GO 確認の上で実行 (Phase 1 では手動、Phase 2 で session 終了 hook 化検討)。

**worktree が無い場合の事故** (過去 dogfood で実地観察): main と supervisor が同 cwd を共有していると、main の `git checkout` が supervisor の作業 tree (uncommitted changes) を上書きする。具体例: main が別 branch に switch → supervisor の SKILL.md edit が nuked。**worktree 分離はこの class of bug を防ぐ唯一の手段**。

### Multi-worker 並列 (coordinator=main) の標準手順 — N 独立 sub-PR

1 feature を **N 個の独立 sub-PR に分けて並列実装** する標準構成。Phase 4 Turso
で確立した運用パターン。
上記「Worktree 分離」 scope 判定 table の **異 PR / 異 branch 並走** に該当する
ケースの具体 recipe。

#### topology

- **coordinator pane = 共有 dir (project root、main 所有)**: coordination
  (relay 調整 / review queue 捌き / conflict 解消) に加えて、自分の sub-PR も
  共有 dir で実装してよい (= "coordinator=main"、過去事例では複数 sub-PR を
  coordinator が担当した)。supervisor 機能と main 機能の hybrid
- **各 worker pane = 専用 worktree + 専用 branch**: `.worktrees/<topic>`
  (例: `.worktrees/turso-green` / `turso-yellow`) を切り、worker は起動直後に
  `cd .worktrees/<topic>` で自 worktree へ移動して作業

#### なぜ worktree 分離が必須か

cmux pane は cwd を共有するので、worker が共有 dir で `git checkout -b` した
瞬間 **全 pane の working tree が切替わる**。Phase 4 で 2 worker + coordinator
が同一 dir を共有 → worker1 の checkout が他 pane を巻き込む事故を、worker 専用
worktree で構造的に解消した (上記「Worktree 分離」の Day-1 事故と同 class)。

#### worktree 作成 (coordinator が bootstrap 時に)

```bash
# 各 worker 用に専用 worktree + 専用 branch を切る (-b 必須、origin/main を base)
git worktree add -b feat/<topic>-green  .worktrees/turso-green  origin/main
git worktree add -b feat/<topic>-yellow .worktrees/turso-yellow origin/main
```

`.worktrees/` は `.gitignore` 済。teardown は全 sub-PR merge 後に
`git worktree remove .worktrees/<topic>` (user GO の上で)。

#### relay で明示する 2 点

- **「専用 worktree に `cd` してから作業」を literal に**: worker への briefing
  relay file に `cd .worktrees/<topic>` を明記。共有 dir で作業させない
- **他 worker の最新 push を fetch してから diagnosis** (既存「diagnosis 前の
  context refresh」節と同じ default 行動)

#### 並列 test の host port 衝突

複数 worktree が各々 test runner (DB を立てる種類) を起動すると、DB の host port
binding が衝突しうる (container / network / volume は worktree ごとに isolated でも、
host port だけは同じ port を取り合う)。回避策は repo 固有 (test runner の種類 / port
の決定的導出方法) なので **`harness/devteam.local.md` の parallel-test-setup 節を参照**
する。local.md に記載が無ければ「DB を要する並列 test は 1 worker に直列化」を default
にする。

#### integration branch 要否 / codex review

- 各 sub-PR の中間着地が prod を壊さない (shadow gate OFF default 等) なら、
  integration branch を使わず main 直 PR (`Refs #N`) で並列着地して OK
  (Phase 4 はこの運用)。破壊的中間状態を伴うなら integration branch flow (local.md rule-refs)
- coordinator の codex pane は共有 dir (main の checkout) で動くため worktree
  branch の PR は test 実行できない → review dispatch 時は **diff-only 指示**
  を含める (詳細は `codex-review` SKILL「Step 3.6: worktree PR は diff-only 指示」節)

### 前段 = DW feature-decompose (分解 + 着手前 audit)

multiworker (上記節) の **前段** = 「feature を sub-PR に割る / 各 worker の write-set を決める /
依存順序を引く / 着手前 audit」を、手作業でなく **Dynamic Workflows の `/feature-decompose`**
で生成する。DW が strictly 得意な分析フェーズで、ここを外すと共有 registry 衝突 / scope 漏れ /
async 衝突を後段の codex review round でようやく踏む (過去 dogfood 実証: 人間 flow が review/self-review
でやっと捕まえた issue を DW 前段が着手前に flag できた)。

**境界 (literal)**:
- **DW = 前段のみ**: 分解 / write-set / 依存 / adversarial audit。**decompose+audit の 2 層セットで使う**
- **devteam = 後段**: codex クロスベンダー review + 実行中 live 介入 + 人間 GO。DW が構造的に持てない領分
  (subagent は全部 Claude = codex 不可、走行中 agent の live steering 不可)

**手順**:

1. **起動**: `/feature-decompose` を `args: { feature: "<日本語説明>", scope: ["<触る dir/file>", ...] }`
   で実行。`{ decomposition, audit_flags }` が返る (中間調査は DW 内に留まり main context を汚さない)
2. **咀嚼 (鍵)**: **decompose 単体を信用しない**。`audit_flags` を読み、P1/P2 を「着手前に潰す懸念」に
   昇格する。過去 dogfood で decompose が楽観的に並列可と外したのを audit 層が deploy 順 P1 で矯正した
   実証に基づく。audit を読み飛ばすと地雷を踏む
3. **briefing 化**: 各 worker の `/tmp/devteam_relay_<topic>-r<N>-<alias>.md` に、その worker の
   `write_set` (= 触る path リスト、上記「B. main 別 file path / 新規 file 命名 の pre-assign」節と
   合流) と、該当する `audit_flags` を「実装前に対処する既知の懸念」として埋める
4. **以降は本節の既存 multiworker flow 不変**: worktree 分離 / codex review / live 介入 / 人間 GO

**適用判断**: 本節 multiworker の発動条件 (~300 LOC 超 / component 3+ / 独立 sub-PR、`harness/devteam.local.md`
の rule-refs) と同じ。trivial feature は前段 DW 不要 (overhead > 価値)。

**degrade**: DW は research preview。workflow script が動かなくなったら前段を手作業に倒す (= 本節の
従来 multiworker そのまま)。後段は無傷。

### cmux tree 役割判別 (alias 振り分け)

```
1. supervisor = ◀ here pane
2. all_claude = "Claude Code" title pane の全列挙
3. main_panes = all_claude - supervisor
4. main_panes が 0 → main 不在 (bootstrap 提案)
5. main_panes が 1 → single-main mode (alias 省略、現状互換)
6. main_panes が 2-3 → multi-main mode (alias = m1, m2, m3 を順に振る)
7. main_panes が 4+ → 「Phase 1 の上限超え、4+ は別 workspace 推奨 (Phase 2)」を user に提示
8. reviewer = "Claude Code" title でない pane (codex)
```

### ask / report routing

main → supervisor の prefix から alias を抽出して文脈管理:

- `[main:m1→supervisor] ask "..."` → user 提示時に冒頭に **"main:m1 が問いかけ:"** を付ける
- `[main:m2→supervisor] report: ..."` → status 更新で main:m2 行を進捗反映

supervisor の返信は必ず `[supervisor→main:<alias>]` で alias 明示。送信は対応 surface (`alias_map[m1].surface`) に `cmux send`。

### Reviewer queue (FIFO)

reviewer (codex) は 1 つのまま (multi-reviewer は Phase 2 scope)。複数 main からの review request は supervisor 内 FIFO queue:

```
m1 report → codex dispatch → 完了 → m1 verdict
  ↓
m2 report (m1 review 中) → queue 末尾に enqueue → "queued (1 ahead)" を m2 に通知
  ↓
m1 verdict 完了 → queue から m2 取出 → dispatch
```

queue は supervisor session ephemeral (文字列 list で管理)。queue 状態は `/devteam status` 出力に含める。

### bootstrap (multi-main)

`/devteam bootstrap multi <N>` で main を N 個立てる (N=2 or 3、上限 3)。

```bash
# 例: 2-main bootstrap
/devteam bootstrap multi 2

# supervisor 動作:
# 1. user GO 確認 (1 回だけ、layout / worktree path / 各 main 用 branch 名提示)
# 2. cmux new-split で main:m1 / main:m2 用 pane 作成 + claude 起動
# 3. git worktree add -b <m1_branch> <worktree-prefix>-m1 main   # -b 必須 (詳細は「Worktree 分離」節)
# 4. git worktree add -b <m2_branch> <worktree-prefix>-m2 main   # 同上
# 5. 各 main pane で cd <worktree-prefix>-<alias> + プロンプト整え
# 6. 役割 marker file 書込 (/tmp/cmux-role-surface-<id>.txt に "main:m1" / "main:m2")
# 7. supervisor 内 alias_map を session memory に保持 (cmux tree で再構築可能)
# 8. 各 main に briefing relay file (/tmp/devteam_relay_<topic>-r1-<alias>.md) を落とし、
#    cmux send で短い 1 行メッセージ (path + Read tool 指示 + report transport の literal cmux send 例)
#    を送る (詳細は「briefing transport (cmux send literal 必須)」節)
```

既存 `/devteam bootstrap` (引数なし) は **single-main mode** で動作 (現状維持)。`bootstrap multi 1` は意味なし (single-main と同等) なので reject。

### briefing transport (cmux send literal 必須)

bootstrap 直後の各 main 向け briefing relay file (`/tmp/devteam_relay_<topic>-r<N>-<alias>.md`) には、main が **report / ask 時に Bash tool 経由で `cmux send` を literal 実行** することを **コードブロック付きで明示** する。これを欠くと main は「prefix 付きテキストを pane に出力するだけ」で済ませてしまい、supervisor pane に届かない (過去 dogfood で実地観察)。

briefing 末尾には以下の **transport literal block** を必ず含める。`<supervisor_surface>` は session ごとに変わる ID なので、**supervisor が bootstrap 時に `cmux tree` で検出した実 surface (例: `surface:5`) を briefing relay file 書き出し時に literal 埋め込み** する (placeholder のまま main に渡さない、main 側で `cmux tree` させない):

```bash
# 完了 / step 区切りで supervisor pane に push する手順:
cmux send --surface <supervisor_surface> "[main:m1→supervisor] report: <要約 — 完了 step / test 結果 / 次候補>"
cmux send-key --surface <supervisor_surface> return
```

**ポイント** (briefing 文中に書く):
- text 出力ではなく **Bash tool 経由の `cmux send` が transport 本体**
- `cmux send-key --surface <supervisor_surface> return` で確定送信が完了 (return 抜けは silent failure)
- prefix は `[main:<alias>→supervisor]` で alias 必須 (multi-main mode のとき)
- ask の場合も同パターン (`[main:m1→supervisor] ask "..."`)
- `<supervisor_surface>` は **bootstrap 時の cmux tree 検出値** で必ず literal 化 (cycle 1 dogfood は偶然 surface:1 だったが固定値に依存しない)

#### briefing 必須節 (過去 dogfood reflection)

bootstrap 時 / relay 時の briefing relay file には、 transport literal block
に加えて以下の **4 必須節** を含める。 cycle 2 dogfood で各々 1 件以上 routing
/ coordination footgun を踏んだので、 briefing 段階で塞ぐ。

##### B. main 別 file path / 新規 file 命名 の pre-assign

multi-main の各 briefing に **「触る file path / 新規作成する file 名 を
literal 列挙」** を必須節として含める。 同 PR 内 task split のとき特に重要
(cycle 2 で `test_storage_fallback.py` を m1/m2 共に「新規作成」 と書いて
create-create conflict 必至 → supervisor が runtime で rename patch)。

briefing 文中 (relay file 内) の節例:

```markdown
## main:m1 の write set (本 task で touch する path)

- write 対象 (新規 / edit OK):
  - `backend/src/storage.py` (transparent fallback 実装)
  - `backend/src/exceptions.py` (新 exception 追加)
- read-only (m2 が write、 m1 は参照のみ):
  - `backend/tests/test_storage_fallback*.py`
  - `backend/tests/fixtures/raw_archive_fixtures.py`
- 新規作成 file の literal 命名:
  - `backend/src/storage_compat.py` (m1 が作成、 m2 と命名衝突しない)
```

supervisor は bootstrap 時 alias_map に `scope` を記録:

```
{
  "m1": { ..., scope: { write: ["backend/src/storage.py", ...], read: [...] } },
  "m2": { ..., scope: { write: ["backend/tests/test_storage_fallback.py", ...], read: [...] } }
}
```

衝突検知: supervisor が m1/m2 の file create を `cmux read-screen` で監視
できれば、 同名 path を 2 main が掴みかけたら relay で警告 (Phase 1 では
manual な watch、 Phase 2 で hook 化)。

##### C. main pane は polling bash を立てない、 queued message を待つ

briefing に **literal の 1 節として明記**:

```markdown
## supervisor からの relay の受け方

supervisor からの relay は **prompt queue に届く queued message** として
待機します。 自分で `cmux read-screen --surface ... grep ...` を polling
する bash loop は **絶対に立てないこと** (cycle 2 dogfood で wrong surface
grep + 8 分以上 false negative の incident あり、 過去 dogfood の実例)。

通常の Read tool / 通常 prompt 受信で十分: supervisor が 「Read tool で
`<path>` を読んで実行してください」 と send したら、 prompt queue に
入って自分の次 turn で受け取れる。 `cmux send` は同 surface の prompt
queue に append するので、 polling 不要。
```

skill 禁止事項 list (本 SKILL.md 末尾「注意事項」 節) にも literal 列挙:

- main pane で `until cmux read-screen ... grep ...; do sleep N; done`
  形式の自前 polling bash を立てる (queued message 配信を阻害)

##### D. diagnosis 前に他 main の最新 push 状態を fetch (context refresh)

briefing に **default 行動として明記**:

```markdown
## diagnosis 前の context refresh (必須)

`pytest` / `git log` / 任意の analyze で他 main の作業範囲に踏み込む前は、
**必ず `git fetch origin <他 main の branch>` で最新 commit を取り込む**。
他 main は別 main の進捗を仮定しない (過去 dogfood で m1 が m2 の commits
を未取込で stale な context で diagnosis、 過去 dogfood の実例)。

例: m1 が R2 で「2 failure は m2 territory 推奨」と report する前に:

\`\`\`bash
git fetch origin <m2_branch>      # 最新 m2 commit を取り込む
git log origin/<m2_branch> --oneline | head -5   # 何が m2 で進んだか確認
\`\`\`
```

supervisor 側の補完: relay の度に他 main の最新 commit SHA + 1 行要約を
briefing に含めると main の自前 fetch を省略できる (Phase 1 では best-effort、
Phase 2 で全 push の broadcast protocol 検討)。

##### E. cherry-pick / rebase / amend / force-push は user GO 必須 (再強調)

briefing template の **「自動化境界」 / 「user GO 必須」 table** に literal で:

| operation | GO 必要か | 例 |
|---|---|---|
| `git commit` | **不要** (devteam handoff flow 中) | 通常の commit |
| `gh pr create` | **不要** | PR open |
| `git push -u origin <branch>` | **不要** | 通常 push |
| **`git cherry-pick`** | ⚠️ **必要** | 別 main の commit を自 branch に取り込む |
| **`git rebase`** | ⚠️ **必要** | base 切替 / squash |
| **`git commit --amend`** | ⚠️ **必要** | 直前 commit の改変 |
| **`git push --force[-with-lease]`** | ⚠️ **必要** | 公開済 commit の上書き |
| `gh pr merge` | ⚠️ **必要** | merge は user trigger |
| 本番 deploy (local.md deploy-commands) | ⚠️ **必要** | 本番 deploy |

supervisor の cherry-pick dispatch 直前 self-check: cycle 2 dogfood で
supervisor が R1 cherry-pick (m2 → m1) を user GO なしで dispatch した
事故 (過去 dogfood の実例) を踏んだので、 supervisor は `cmux send` 直前
に「user GO 取得済か?」 を mental check。 1 GO で「同 PR 整合 fix の
cherry-pick chain 全体」 を pragmatic に包む解釈は OK (literal 都度 GO は
noise 多)。

**briefing 全体テンプレ**は project 内 `/tmp/devteam_relay_*-bootstrap-r1.md` の流用 history を見ると分かりやすい。supervisor が短い 1 行 `cmux send` で main に「Read tool で `<path>` を読んで実行してください」と送り、main が file 全文を Read した上で実装 → 完了で literal `cmux send` を打つ、という flow が standard。

### status 出力 (multi-main)

```
## devteam status (multi-main mode, N=2)

### main:m1 (surface:3 / workspace:1 / worktree: <worktree-prefix>-m1)
state: running
last activity: implementing fix for issue A (Round 1)
current task: harness/135-frame-analyzer-fixture branch

### main:m2 (surface:5 / workspace:1 / worktree: <worktree-prefix>-m2)
state: idle
last activity: bootstrap 完了、task 待機中
current task: -

### supervisor (surface:1 / here)
state: active
review queue: [m1:codex_135-r1.md (running), m2:- ]

### reviewer (surface:2 / codex gpt-5.5 high)
state: working m1's issue A review (started 2 min ago)
```

### Phase 1 制限 (本実装の scope 外、Phase 2 候補)

- **main 上限 3 個** (4+ は別 workspace 推奨)
- **multi-reviewer なし** (P1 critical PR を 2 reviewer に dispatch 等は Phase 2)
- **worktree teardown は手動** (session 終了 hook で自動化は Phase 2)
- **layout 自動最適化なし** (4-quadrant は手動 split を組み合わせる)
- **別 workspace 跨ぎ multi-main 非サポート** (同 workspace に絞る)
- **DB を要する integration test の並列制限**: DB の host port が worktree 間で衝突する種類の test runner では、複数 main で並走できない場合がある (詳細・回避策は `harness/devteam.local.md` の parallel-test-setup 節)。記載が無ければ DB を要する test は 1 main で逐次走らせる

### dogfood 中の注意

本 mode は multi-main の運用パターン。session で観察した routing miss / queue 漏れ / worktree トラブル / context bloat は retro に記録し、本 skill を更新する。

観察観点 (4 つ):
- **routing miss**: alias 不一致で別 main に届かない事故
- **queue 漏れ**: review queue から request が抜け落ちる
- **worktree トラブル**: branch / worktree の整合性崩れ
- **context bloat**: supervisor の alias_map / queue 管理で context が膨れる

dogfood 期間で 1 件以上 trouble 観察したら必ず retro-write に記録、本節を update。

**既知事象**: worktree 未使用 + main と supervisor 同 cwd 共有で作業 tree 上書き事故が起きる (上記「Worktree 分離」節参照)。worktree 分離でこの class of bug を構造的に解消する。

### 既存節との関係 (cross-reference)

multi-main mode を使うとき、以下既存節の参照先が拡張される:

- 「## 共通: 役割自動判別」→ 上記 「cmux tree 役割判別 (alias 振り分け)」 で置換
- 「## 共通: ペイン間メッセージ prefix 規約」→ 上記 「Prefix scheme (alias 付き)」 で拡張 (table 内の `[main→supervisor]` / `[supervisor→main]` を alias 形に置換)
- 「## 共通: supervisor → main の長文 transport (file 経由)」→ relay file 命名規約に alias suffix が追加 (上記 「relay file 命名」)
- 「### bootstrap」→ `bootstrap multi N` variant が追加
- 「### status」→ multi-main 出力 format に切替 (上記 「status 出力 (multi-main)」)

single-main mode (m1 1 つだけ or alias 不在) では既存節の旧形をそのまま使う (後方互換)。

## 注意事項

- **自動化の境界**: 中間ステップ (review dispatch / 結果回収 / 修正差し戻し / 再 review / test 走らせる) は supervisor 判断で自動進行。**ただし commit 実行 / 本番デプロイ / prod DB 書き換え / 外部通知 / force push / branch 削除 / リリース作成 は user 明示 GO 必須**。
- **auth 境界での停止パターン**: approve 後や重要判断点では「commit しますか?」「deploy しますか?」の形で user に 1 問だけ投げて待機。それ以外は報告 + 自動前進
- **surface ID 固定化しない**: session 切り替えで ID が変わるので毎回 `cmux tree` で判別
- **main が複数ある workspace**: 「## Multi-main mode (Phase 1, dogfood)」節参照。bootstrap multi N で立てた multi-main mode なら supervisor が alias 振って routing、それ以外で偶然 main が複数あれば user に確認 (意図せぬ pane 残骸の可能性)
- **Monitor のタイムアウト** は 30 分上限。長い review は再張り込み必要
- **`cmux send` は改行入らない**: 送信後に必ず `cmux send-key return` で確定させる
- **main pane で自前 polling bash 禁止 (過去 dogfood の実例)**: `until cmux read-screen --surface ... grep ...; do sleep N; done` 形式で supervisor からの指示を待つ bash loop は **絶対に立てない**。 supervisor からの relay は **prompt queue に届く queued message** として待機するので、 通常の Read tool / 通常 prompt 受信で十分。 polling は wrong surface grep + 8 分以上 false negative を踏む footgun (過去 dogfood 実例)
- **diagnosis 前の context refresh (過去 dogfood の実例)**: multi-main で他 main の作業範囲に踏み込む前は `git fetch origin <他 main の branch>` を default 行動に。 他 main の進捗を仮定せず、 最新 commit を取り込んでから analyze する
- **本 skill (devteam) は共通 repo (agent-skills) の shared 版**。project 固有値 (deploy コマンド / worktree path / 並列 test 設定 / rule 参照) は **ここに書かず `harness/devteam.local.md` に置く** (汎用本体を不変に保つ)。本 SKILL.md 自体の編集は全 consumer repo に波及するので blast radius を意識する (local.md の rule-refs に各 repo の skill 編集ルールがあれば従う)
- **再 review ループ上限**: 基本は無制限で auto。approve になるまで needs-changes → 修正 → 再 review を supervisor 判断で回し続ける。以下のいずれかが起きたら user に相談して止まる:
  - 同じ指摘が 3 周連続で出て解消していない (=堂々巡りのサイン)
  - 新規の P1 指摘が round を追うごとに増えている (= scope 拡大)
  - codex が approve とも needs-changes とも判断できずに保留し続けた

## ログ

devteam の操作ログは残さない (state は毎回 `cmux tree` + read-screen で再現できるので)。