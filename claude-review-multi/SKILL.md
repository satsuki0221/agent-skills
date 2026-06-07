---
name: claude-review-multi
description: Claude サブエージェントで 4 人のレビュアー (Correctness / Risk / UI-UX / Language-framework) を並列起動し coordinator が統合するマルチレビュー。codex CLI も cmux ペインも不要で、Workflow ツール経由で動く codex-review-multi の Claude 実装。git diff <base>...HEAD または未コミット差分を対象にする。ユーザーが `/claude-review-multi`, `crvc`, 'claude でマルチレビュー', 'claude 版マルチレビュー', 'claude でコードレビュー (並列)' 等を言ったときにトリガー。
---

# claude-review-multi

Claude のサブエージェントを 4 並列で走らせるマルチレビュー。codex (契約/クレジット) に依存せず、
Workflow ツールが `~/.claude/workflows/claude-review-multi.mjs` を実行して
4 reviewer (Correctness / Risk / UI-UX / Language-framework) + 統合 coordinator を回す。

これは `codex-review-multi` の Claude 版。役割・出力フォーマット (Reviewed by / 新規または拡大した指摘 /
総評 / 既存の無関係な問題 / 残留リスク / Patch verdict) は codex 版に準拠する。

## Prerequisites

- git リポジトリ内で実行すること。
- Workflow スクリプトが存在すること: `~/.claude/workflows/claude-review-multi.mjs`
  (無ければこの skill が壊れているので、ユーザーに知らせて中断。下記「インストール」参照)。

## インストール (consumer)

この skill は同梱の `claude-review-multi.mjs` を Workflow ツールで実行する。SKILL.md を
`.claude/skills/claude-review-multi/` に配置するのに加え、`claude-review-multi.mjs` を
Workflow が読めるパス `~/.claude/workflows/claude-review-multi.mjs` にコピー or symlink すること:

```bash
ln -sf "<この skill dir>/claude-review-multi.mjs" ~/.claude/workflows/claude-review-multi.mjs
```

## Argument parsing

ユーザー入力から以下を抽出する (順不同)。トリガー語 (`crvc` / `/claude-review-multi` 等) や
「claude でマルチレビュー」のような呼び出し文言は引数ではない (位置引数・extra に含めない)。

| フラグ | 値 | デフォルト |
|-------|----|----------|
| (位置引数 1 つ目) | base branch / commit | origin のデフォルトブランチ (`git symbolic-ref --quiet refs/remotes/origin/HEAD` の末尾) or `main` |
| `--uncommitted` / `-u` | なし (bool) | off |
| `--worktree <path>` | レビュー対象の作業ツリー | 現在の repo root (`git rev-parse --show-toplevel`) |
| 残りの自由文 | reviewer への追加指示 (extra) | `なし` (空なら文字列 `なし` を渡す。空文字 `""` ではない) |

## Scope と diff 算出

すべて `--worktree` のパス上で `git -C <worktree>` を使って算出する
(別 worktree / 別ブランチを cwd で誤って見ないため)。

### branch mode (default)

- base が **明示された**ら、その値をそのまま使う (スラッシュ入りブランチ名でも末尾を切らない)。
- base が **未指定**なら `git -C <wt> symbolic-ref --quiet refs/remotes/origin/HEAD` の末尾、取得失敗なら `main`。
  `refs/remotes/origin/main` のような出力からブランチ名だけ取るため、**この既定値算出のときだけ**
  `${ref##*/}` で末尾を取る (明示された base には適用しない)。
- 採用した base が解決できるか検証する: `git -C <wt> rev-parse --verify --quiet "<base>^{commit}"`。
  解決できなければ「base '<base>' が見つかりません」で中断 (typo した base で `<base>...HEAD` が
  git エラーや誤った diff になるのを防ぐ)。
- `diffRange = "<base>...HEAD"`
- `files=$(git -C <wt> diff --name-only <diffRange> | sed '/^$/d' | wc -l)` が 0 なら
  「<diffRange> に差分がありません」で中断。

### uncommitted mode (`--uncommitted` / `-u`)

- `diffRange = "HEAD"` (= `git diff HEAD`)。**レビュー対象は tracked な未コミット差分のみ** (staged + unstaged)。
  **untracked ファイルは `git diff HEAD` に乗らないのでレビューされない。**
- `tracked=$(git -C <wt> diff HEAD --name-only | sed '/^$/d' | wc -l)` が 0 なら中断する。
  untracked の有無で続行判断を変えない (untracked があっても `git diff HEAD` は空のままで、
  reviewer は空差分を見るだけ＝5 agent が無駄に走る)。
- 中断時に untracked が存在するなら理由を添える:
  「tracked な未コミット差分がありません (untracked N 件はレビュー対象外。含めたいなら
  `git add -N <files>` で intent-to-add するか、コミットしてから branch mode で実行)」。

## 実行 (Workflow ツール)

Workflow ツールを呼ぶ (skill 経由なので Workflow の opt-in 条件を満たす):

```
Workflow({
  scriptPath: "~/.claude/workflows/claude-review-multi.mjs",
  args: {
    worktree: "<repo root の絶対パス>",
    diffRange: "<base>...HEAD",
    extra: "<追加指示。無ければ なし>"
  }
})
```

注意:
- 上の例の `<...>` はプレースホルダ。実値に置換し、コメントや山括弧を残さない素の値だけを渡す。
- `scriptPath` の `~` はホームディレクトリ。絶対パスに展開して渡す (ホームが `/Users/<ユーザー名>` なら `/Users/<ユーザー名>/.claude/workflows/claude-review-multi.mjs`)。
- `diffRange` は branch mode なら `<base>...HEAD`、uncommitted mode なら `HEAD` (上の「Scope と diff 算出」参照)。
- `exclude` (省略可・文字列配列) は codegen 生成物等の pathspec。レビュー差分から除外する。既定は除外なし。
  repo 固有の生成物パスはここで渡す (skill 本体には書かない)。例: `exclude: ["api/gen", "src/proto"]`。
- `args` は **JSON オブジェクトで渡す** (文字列にすると script 側で worktree 等が undefined になり
  デフォルトの cwd / main...HEAD に落ちて別物をレビューしてしまう)。script 側は文字列でも
  パースするよう防御しているが、オブジェクトで渡すのが正。
- 対象差分の背景・意図・既知トレードオフ・既出指摘の修正内容などは `extra` に詰めると
  reviewer の誤検知が減る。
- Workflow はバックグラウンドで走り、完了通知が来る。`/workflows` で進捗を見られる。

## 完了後

- Workflow の戻り値 (統合レビュー本文: Reviewed by / 新規または拡大した指摘 / 総評 /
  既存の無関係な問題 / 残留リスク / Patch verdict) をユーザーに提示する。
- 指摘を直す場合は superpowers:receiving-code-review の姿勢で、各 finding を実コードで検証してから対応する。

## スクリプトの中身 (参考)

`~/.claude/workflows/claude-review-multi.mjs`:
- `parallel()` で 4 reviewer を並列起動 (各 `agentType: 'general-purpose'`、structured findings schema)。
- 各 reviewer は `git -C <worktree> diff <diffRange>` を実行 (codegen 生成物等を除外したい場合は
  `args.exclude` に pathspec 配列を渡す。既定は除外なし)。
- coordinator agent が findings を統合・重複排除・矛盾解決して最終レビューを日本語で出力。
- iterate する場合はこのスクリプトを編集して `Workflow({scriptPath, args})` で再実行。

## codex 版との違い

- codex 不要 (契約/クレジット/認証トークンの問題を回避)。
- cmux ペイン不要 (Workflow がサブエージェントを直接 fan-out)。
- reviewer は Claude。codex-review-multi (`/codex-review-multi`) は codex CLI を使う別系統。
