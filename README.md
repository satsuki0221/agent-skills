# agent-skills

複数 repo で共有する agent skill (Claude Code / Codex)。各 consumer repo が submodule で参照する。

## 収録 skill

- `devteam/` — cmux マルチペイン開発チーム (main / supervisor / codex reviewer) のオーケストレーション。
  Claude 専用 (`agents: [claude]`)。bootstrap / relay / review / status / ask / report / multi-worker /
  前段 DW feature-decompose handoff を持つ。**project 固有値** (deploy コマンド / worktree path /
  並列 test 設定 / 正本ルール参照) は本体に書かず、consumer 側の `harness/devteam.local.md` で override する。
- `claude-review-multi/` — Claude サブエージェント 4 並列のマルチレビュー (Correctness / Risk / UI-UX /
  Language-framework) + coordinator 統合。codex / cmux 不要、Workflow ツールで動く。同梱の
  `claude-review-multi.mjs` を `~/.claude/workflows/` に配置 (コピー or symlink) して使う。**repo 固有の
  codegen 除外**は `args.exclude` (pathspec 配列) で渡す — 本体には書かない。
- `codex-review-multi/` — codex CLI で 4/6/8 reviewer のマルチレビュー。`using-cmux` で別ペインに
  `codex exec` を立ち上げて結果を回収する (cmux + codex CLI 前提)。reviewer プロンプトは `prompts/` に外出し。

## consumer での使い方

```bash
# submodule として追加
git submodule add https://github.com/satsuki0221/agent-skills vendor/agent-skills

# clone 直後 / submodule 未取得のときは init が必要 (忘れると symlink が dangling になる)
git submodule update --init --recursive
```

consumer 側で `harness/skills/<name>` を `../../vendor/agent-skills/<name>` への symlink にすると、
既存の skill symlink 体系 (`.claude/skills/<name>` を張る sync スクリプト等) が無改変で解決する:

```
.claude/skills/devteam → harness/skills/devteam → vendor/agent-skills/devteam/SKILL.md
```

### project 固有値の override

`harness/devteam.local.md` に repo 固有の値を置く (汎用 SKILL.md がこのファイルを参照する):

- `deploy-commands` — user GO 必須の不可逆 deploy コマンド
- `worktree-prefix` — multi-worker の worktree path 規約
- `parallel-test-setup` — 並列 test の host port 衝突回避
- `rule-refs` — 実装 handoff / review / integration branch / skill 編集の正本ルール参照

local.md が無くても skill は動く (汎用の保守的境界で deploy GO を判定)。

## 開発

```bash
bash scripts/check-generic.sh
```

各 `<name>/SKILL.md` に project 固有 token (deploy コマンド名 / 特定 repo 名 / GOLDEN_RULES ID /
issue 番号 / 日付 provenance) が混入していないかを確認する gate。固有値は consumer 側 local.md へ。
