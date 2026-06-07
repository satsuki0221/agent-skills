---
name: codex-review-multi
description: "Codex CLI で 4/6/8 人のレビュアーを並列起動するマルチレビュー。git diff <base>...HEAD または未コミット差分を対象に、Codex exec を using-cmux の別ペインで実行して結果を回収する。ユーザーが `/codex-review-multi`, `crv2`, 'codex でコードレビュー', 'multi-reviewer code review' 等を言ったときにトリガー。"
---

# codex-review-multi

Codex CLI を使って 4/6/8 人の reviewer lane を持つマルチレビューを実行する。Codex は `using-cmux` で別ペインに立ち上げ、現在のペインはユーザーとの対話に使い続ける。

## Prerequisites

- `cmux` (CMUX_SOCKET_PATH が存在する cmux 内セッション)
- `codex` CLI がインストール済み
- git リポジトリの中で実行
- `--codex-home <path>` が指定された場合は `<path>` が存在するディレクトリであること

これらが無ければ実行不可なので、冒頭で確認し、欠けていたらユーザーに伝えて中断する (各中断文言は「エラーハンドリング」節の「前提チェック失敗」表を参照)。

## Argument parsing

ユーザー入力から以下を抽出する。引数は順不同で良い。

| フラグ | 値 | デフォルト |
|-------|----|----------|
| (位置引数 1 つ目) | base branch 名 | `git symbolic-ref --quiet refs/remotes/origin/HEAD` の末尾 or `main` |
| `--uncommitted` / `-u` | なし (bool) | off |
| `--fast` | なし (bool) | off |
| `--no-fast` | なし (bool) | - |
| `--reviewers` / `-n` | `4` / `6` / `8` | `4` |
| `--codex-home` | CODEX_HOME のパス (任意、例: `$HOME/.codex-work`) | `$HOME/.codex` |
| 残りの自由文 | 追加 reviewer instructions | `なし` |

`--codex-home` は `env CODEX_HOME=<value>` としてそのまま渡す。指定ディレクトリが存在しなければ codex 起動前に中断する (中断文言は「エラーハンドリング」節の「前提チェック失敗」表で一元管理)。

## Review scope と diff stats の算出

### `review_mode=branch` (default)

```bash
# base: 位置引数 1 つ目が指定されていればそれを使う。
# 未指定なら `git symbolic-ref --quiet refs/remotes/origin/HEAD` 経由で
# origin のデフォルトブランチ名を取り、その末尾セグメントを採用する。
# 取得失敗 (remote 未 fetch / origin/HEAD 未設定) なら `main` に fallback。
# スラッシュ入りブランチ名 (`feature/foo`) を壊さないよう、basename ではなく
# `${ref##*/}` 形式の bash parameter expansion で末尾だけ切り出す。
if [[ -z "${base:-}" ]]; then
  if ref=$(git symbolic-ref --quiet refs/remotes/origin/HEAD 2>/dev/null); then
    base="${ref##*/}"
  fi
  base="${base:-main}"
fi
diff_range="${base}...HEAD"
files=$(git diff --name-only "$diff_range" | sed '/^$/d' | wc -l | tr -d ' ')
insertions=$(git diff --numstat "$diff_range" | awk '{ if ($1 ~ /^[0-9]+$/) a += $1 } END { print a + 0 }')
deletions=$(git diff --numstat "$diff_range" | awk '{ if ($2 ~ /^[0-9]+$/) d += $2 } END { print d + 0 }')
total=$((insertions + deletions))
```

- 差分 0 件 (`files==0`) ならエラー「${diff_range} に差分がありません」で中断。
- `REVIEW_SCOPE` = `- Compare this branch using: git diff ${diff_range}`
- `DIFF_STATS` = `- Diff stats: ${files} files changed, ${insertions} insertions, ${deletions} deletions, ${total} total line changes.`

### `review_mode=uncommitted` (`--uncommitted` / `-u`)

このモードでは base は使わない (位置引数として渡されても無視する。警告は出さない)。HEAD に対する working tree の差分 + untracked ファイル数を対象にする。

```bash
files=$(git diff --name-only HEAD | sed '/^$/d' | wc -l | tr -d ' ')
insertions=$(git diff --numstat HEAD | awk '{ if ($1 ~ /^[0-9]+$/) a += $1 } END { print a + 0 }')
deletions=$(git diff --numstat HEAD | awk '{ if ($2 ~ /^[0-9]+$/) d += $2 } END { print d + 0 }')
untracked=$(git ls-files --others --exclude-standard | sed '/^$/d' | wc -l | tr -d ' ')
total=$((insertions + deletions))
```

- `files==0` かつ `untracked==0` ならエラー「HEAD に対する未コミット差分がありません」で中断。
- `REVIEW_SCOPE` = `- Compare the current uncommitted change using: git status --short and git diff HEAD`
- `DIFF_STATS` = `- Diff stats: ${files} tracked files changed, ${insertions} insertions, ${deletions} deletions, ${total} total line changes, ${untracked} untracked files.`

## Prompt 組み立て

skill ディレクトリを取得してテンプレートを合成する:

```bash
SKILL_DIR="$HOME/.claude/skills/codex-review-multi"
PROMPT_FILE="$(mktemp -t codex-review-prompt.XXXXXX).md"

{
  cat "$SKILL_DIR/prompts/shared-header.md"
  cat "$SKILL_DIR/prompts/reviewers-${REVIEWER_COUNT}.md"
  cat "$SKILL_DIR/prompts/shared-footer.md"
} > "$PROMPT_FILE.raw"

# プレースホルダ置換は POSIX sed だけで行う (python / uv / pyenv 等の
# 言語ランタイム依存を避けるため)。値を sed 引数に渡すとバッククオート
# / ドル記号 / 改行 / `&` / `\` 等でエスケープ地獄になるので、値は
# 一時ファイルに書き出し、sed の `r file` + `d` で「プレースホルダ行
# を削除し、その位置にファイル内容を挿入」する。値は sed の解釈を
# 一切経由しないので任意のバイト列が安全に入る。
RS_FILE="$(mktemp -t codex-review-rs.XXXXXX)"
DS_FILE="$(mktemp -t codex-review-ds.XXXXXX)"
EX_FILE="$(mktemp -t codex-review-ex.XXXXXX)"
printf '%s\n' "$REVIEW_SCOPE" > "$RS_FILE"
printf '%s\n' "$DIFF_STATS"   > "$DS_FILE"
printf '%s\n' "$EXTRA"        > "$EX_FILE"

# `/PATTERN/{r file;d;}` パターン: placeholder 行にマッチしたら、
# 対応するファイルを出力に挿入し (r)、placeholder 行自体を消す (d)。
# テンプレート側では各 placeholder は必ず単独行に置く約束 (shared-header
# と shared-footer で担保済み)。
sed \
  -e '/{{REVIEW_SCOPE}}/{' -e "r $RS_FILE" -e 'd' -e '}' \
  -e '/{{DIFF_STATS}}/{'   -e "r $DS_FILE" -e 'd' -e '}' \
  -e '/{{EXTRA}}/{'        -e "r $EX_FILE" -e 'd' -e '}' \
  "$PROMPT_FILE.raw" > "$PROMPT_FILE"

rm -f "$PROMPT_FILE.raw" "$RS_FILE" "$DS_FILE" "$EX_FILE"
```

`EXTRA` が空なら `なし` を入れる。

## Codex 実行 (using-cmux 別ペイン)

`using-cmux` skill の手順に従う。重要ポイント:

1. 現在のペインはこのセッション — codex は必ず**別ペイン**で立ち上げる。
2. 新規 split を右に作り、`codex-review` とタブ名を付ける。
3. 送信するコマンドは**ダブルクォート**で囲み、中の変数展開を 2 段階に分ける:
   - **main 側で先に展開** (そのまま `$VAR` と書く): `$SURF`, `$CODEX_HOME`, `$CODEX_FLAGS`, `$PROMPT_FILE` など、送信前に値を確定させたい変数
   - **pane 側の zsh に展開させる** (`\$` でドル記号を守る): `\$(cat ...)` のようなコマンド実体。pane に届いてから実行される
   - 同じ式内で両者を混ぜて書いてよい。例: `\"\$(cat $PROMPT_FILE)\"` は main 側で `$PROMPT_FILE` が `/tmp/foo.md` などに確定した上で pane へ送られ、pane 側で `$(cat /tmp/foo.md)` として実行される

```bash
SURF=$(cmux new-split right | awk '{print $2}')
cmux rename-tab --surface $SURF "codex-review"

# fast mode の有無で config フラグを分岐
if [[ "$FAST_MODE" == "on" ]]; then
  CODEX_FLAGS='-c features.fast_mode=true -c service_tier="fast"'
else
  CODEX_FLAGS='-c features.fast_mode=false'
fi

cmux set-status "codex-review" "codex 実行中" --icon hammer

# $CODEX_HOME / $CODEX_FLAGS / $PROMPT_FILE は main 側 bash が先に展開する。
# \$(cat ...) は \$ で守っているため pane 側 zsh で展開される。
cmux send --surface $SURF "env CODEX_HOME=$CODEX_HOME codex --dangerously-bypass-approvals-and-sandbox exec $CODEX_FLAGS \"\$(cat $PROMPT_FILE)\"\n"
```

> 注意: `cmux send` の末尾 `\n` は Enter として機能するが文字列の途中には改行を入れられない (using-cmux の send 改行ルール参照)。上記は単一行コマンドなので OK。

## 完了待機と結果回収

`read-screen` でポーリングし `❯` (または codex CLI の完了マーカー `session id:` 行) を検出する。

```bash
while true; do
  sleep 15
  screen=$(cmux read-screen --surface $SURF --scrollback)
  if printf '%s' "$screen" | grep -qE '^session id: '; then
    break
  fi
  # プロセスが死んでプロンプトに戻った場合も抜ける
  if printf '%s' "$screen" | tail -n 3 | grep -qE '(❯|\$ *$)'; then
    break
  fi
done

full=$(cmux read-screen --surface $SURF --scrollback)
session_id=$(printf '%s\n' "$full" | sed -n 's/^session id: //p' | tail -n 1)
cmux clear-status "codex-review"
```

待機はタイムアウトを設ける (例: 最大 30 分)。途中経過をユーザーに見せたい場合は Monitor / polling の間隔を短めに。

## ユーザーへの報告

- codex が書き出した review 本文 (Reviewed by / 新規または拡大した指摘 / 総評 / 既存の無関係な問題 / 残留リスク / Patch verdict) を抽出して提示する。
- `session_id` があれば resume コマンドも添える:
  ```
  Session ID: <id>
  Resume: env CODEX_HOME=<home> codex exec resume --skip-git-repo-check <id>
  ```
- プロンプトファイル `$PROMPT_FILE` は残しておき、パスをユーザーに知らせる (再実行・デバッグ用)。手動で消したい場合は削除。
- ペイン (`codex-review` タブ) は閉じずに残す — ユーザーが生ログを確認できるようにする。ユーザーが明示的に閉じたいと言ったら `cmux close-surface --surface $SURF`。

## エラーハンドリング

### 前提チェック失敗 (codex 起動前に中断)

codex / cmux pane は起動せず、1 行の文言でユーザーに通知して即終了する。

| 条件 | エラー文言 |
|---|---|
| `CMUX_SOCKET_PATH` 未設定 / cmux 外セッション | `cmux 内セッションで実行してください (CMUX_SOCKET_PATH が見つかりません)。` |
| `codex` CLI 未インストール | `codex CLI が見つかりません。インストールしてから再実行してください。` |
| `git rev-parse --is-inside-work-tree` が false | `git リポジトリの中で実行してください。` |
| `--codex-home <path>` が存在しないディレクトリ | `--codex-home に指定されたディレクトリ <path> が存在しません。既存ディレクトリを指定するか、mkdir -p <path> で作成してから再実行してください。` |
| branch mode で `files==0` | `<diff_range> に差分がありません。` (詳細は「Review scope と diff stats の算出」節) |
| uncommitted mode で `files==0 && untracked==0` | `HEAD に対する未コミット差分がありません。` (詳細は「Review scope と diff stats の算出」節) |

### codex 実行時の失敗

- codex が 0 以外で終了したらステータスを `codex-review-failed` にして、`read-screen --scrollback` の末尾 50 行をユーザーに見せる。
- cmux 関連で失敗したら `using-cmux` skill のトラブルシュート (PTY 遅延初期化、`--surface` vs `--workspace`) を参照する旨を伝える。

## Help 出力

ユーザーが `--help` / `-h` を渡してきたら以下を表示して中断:

```
Usage:
  /codex-review-multi [base] [追加 reviewer 指示...]
  /codex-review-multi --uncommitted [追加指示...]
  /codex-review-multi --fast [base] [追加指示...]
  /codex-review-multi --reviewers <4|6|8> [base] [追加指示...]
  /codex-review-multi --codex-home <path> [base] [追加指示...]

Notes:
  - Default mode reviews git diff <base>...HEAD.
  - --uncommitted reviews the current working tree against HEAD.
  - Default CODEX_HOME は $HOME/.codex。
  - --codex-home で別 CODEX_HOME ディレクトリに切替 (例: $HOME/.codex-work)。
  - --reviewers は 4 / 6 / 8。デフォルトは 4。
  - --fast は Codex Fast mode を有効化 (デフォルトは off)。
  - codex 実行は using-cmux 経由で別ペインに立ち上がる。
  - Untracked files は git status からリストアップされる。patch 形式で見たい場合は事前に git add -N <file>。
```
