export const meta = {
  name: 'claude-review-multi',
  description: 'Claude 版マルチレビュー: 4 reviewer (Correctness/Risk/UI-UX/Lang) を並列起動し coordinator が統合する。codex-review-multi の Claude 実装。',
  whenToUse: 'codex を使わず Claude だけでマルチレビューしたいとき。args: { worktree, diffRange, extra, exclude? }',
  phases: [
    { title: 'Review', detail: '4 reviewer を並列でレビュー' },
    { title: 'Synthesize', detail: 'coordinator が重複排除・矛盾解決・最終判定' },
  ],
}

// args は JSON オブジェクトで渡される想定だが、文字列で渡ってきても壊れないよう
// 防御的にパースする (Workflow tool に args を文字列で渡すと .worktree 等が
// undefined になり、worktree='.' で意図しない repo を見てしまうため)。
const _args =
  typeof args === 'string'
    ? (() => {
        try {
          return JSON.parse(args)
        } catch {
          return {}
        }
      })()
    : args || {}
const worktree = _args.worktree || '.'
const diffRange = _args.diffRange || 'main...HEAD'
const extra = _args.extra || 'なし'
// codegen 生成物等の除外 pathspec。consumer が args.exclude で渡す。既定は除外なし。
// repo 固有の自動生成コード・スキーマ生成物のパスはここで渡す。
const exclude = Array.isArray(_args.exclude)
  ? _args.exclude.filter((p) => typeof p === 'string' && p.length > 0)
  : []

// reviewer が各自実行する差分コマンド。exclude があれば pathspec で除外する。
const excludeArgs = exclude.map((p) => `':(exclude)${p}'`).join(' ')
const diffCmd =
  `git -C ${worktree} diff ${diffRange} -- .` + (excludeArgs ? ` ${excludeArgs}` : '')
const statCmd = `${diffCmd} --stat`

const SHARED_POLICY = `あなたは別のエンジニアが出した変更のレビュアーです。codex 既定のレビュー方針に準拠します。
- correctness / security・privacy / performance / reliability / maintainability / UX に実害のある問題に集中する。
- 弱い・推測的な指摘より「指摘なし」を優先。actionable で具体的な discrete issue だけを挙げる。
- style / naming / フォーマットの好みは、リポジトリ規約や周辺の支配的パターンから明確に逸脱している場合を除き無視。
- 著者の意図や製品ポリシーを勝手に仮定しない。推測的懸念を [P2] より上に上げない。1 finding = 1 issue。
- この差分が原因でない問題は、差分が新たに到達可能/拡大させた場合を除き報告しない。
- 分類を明確に: (1) 新規バグ / (2) 既存挙動が差分で新たに露出・拡大・到達可能化 / (3) 差分と無関係な既存問題。(2)(3) はその旨を明記し、(3) は patch の総合評価に含めない。
- security/privacy は server-side 認可と UI のみの制限を区別し、通常 UI 経由か直接 API のみかを区別する。証拠が弱ければ「残留リスク」に置く。`

const REVIEWERS = [
  {
    key: 'correctness',
    role: 'Correctness reviewer',
    method: `correctness / regression / 挙動変化 / 統合挙動 / edge case / tests / リポジトリ整合性を見る。
- 差分・周辺コード・テストから before/after の意図を再構成してからバグと判断する。
- happy path / edge / 空入力 / nil・null / zero値 / 部分更新 / error path を確認。
- 条件分岐・デフォルト・順序・ページング・状態遷移・cleanup 周りの不変条件を比較。
- 具体的な発火シナリオとユーザー/運用/開発者への影響がある finding を優先。`,
  },
  {
    key: 'risk',
    role: 'Risk reviewer',
    method: `security / 認可 / 権限 / tenant scope / データ露出 / 不適切ログ / 性能退行 / 並行性 / retry安全性 / 冪等性 / migration安全性 / observability を見る。
- データ露出・破損・信頼性低下・運用不安定を生む問題に集中。
- 具体的な failure mode / 負荷影響 / リスク経路がある finding を優先。
- 未明示ポリシー依存や証拠が弱いものは残留リスクへ。`,
  },
  {
    key: 'uiux',
    role: 'UI/UX reviewer',
    method: `視覚的階層 / レイアウト明瞭性 / 操作フロー / affordance / 誤操作防止 / コピー / system status / アクセシビリティ / 情報密度 / 空・loading・error 状態を見る。
- 主操作・現在状態・次操作が一目で分かるか。
- ユーザーが迷う/誤読/誤クリック/重要フィードバックを見落とす箇所を優先。実機未起動ならコード上の導線確認に留め、その旨明記。`,
  },
  {
    key: 'lang',
    role: 'Language/framework reviewer',
    method: `Go: context 伝播 / goroutine寿命 / error handling・wrapping / transport semantics / error文字列規約 / リポジトリ固有 Go パターン。
TypeScript/React: 型安全 / narrowing / assertion / Hook 正当性 / state 構造 / stale closure / 不要 Effect / cleanup / async cleanup / React Query の cache・key の扱い。
強い言語レンズが無ければリポジトリ固有の実装パターンに照らす。`,
  },
]

const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reviewer', 'inspected', 'findings'],
  properties: {
    reviewer: { type: 'string', description: 'reviewer 役割名' },
    inspected: { type: 'string', description: '何を見たか・依拠した参照を 1-2 行' },
    findings: {
      type: 'array',
      description: '弱い指摘より無しを優先。0 件可。',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'title', 'kind', 'confidence', 'detail', 'evidence', 'fix'],
        properties: {
          severity: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
          title: { type: 'string' },
          kind: { type: 'string', enum: ['新規バグ', '既存問題の露出拡大', '既存の無関係な問題'] },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          detail: {
            type: 'string',
            description: 'どんなときに起きるか / 何が困るか / なぜ起きるか を平易な日本語で',
          },
          evidence: {
            type: 'array',
            items: { type: 'string' },
            description: 'plain な file:line（Markdown link 不可）',
          },
          fix: { type: 'string', description: 'どう直すか' },
        },
      },
    },
  },
}

phase('Review')
const reviews = await parallel(
  REVIEWERS.map((r) => () =>
    agent(
      `${SHARED_POLICY}

あなたは **${r.role}** です。次のレビュー手法で見てください:
${r.method}

## レビュー対象
- 作業ツリー: ${worktree}
- まず \`${statCmd}\` で規模を把握し、\`${diffCmd}\` で差分本体を取得する。
- 主張の検証に必要な周辺コードだけを Read で読む。${exclude.length ? ` 除外 pathspec (${exclude.join(', ')}) はレビュー対象外。` : ''}
- ファイルは一切変更しない (read-only レビュー)。

## 追加コンテキスト
${extra}

## 出力
自分の役割の観点での findings を構造化して返す。弱い/推測的な指摘は出さず、具体的で actionable なものだけ。該当が薄い役割なら findings を空にしてその旨 inspected に書く。`,
      {
        label: `review:${r.key}`,
        phase: 'Review',
        schema: FINDINGS_SCHEMA,
        agentType: 'general-purpose',
      },
    ),
  ),
)

const valid = reviews.filter(Boolean)
log(`reviewers done: ${valid.length}/${REVIEWERS.length}, findings total=${valid.reduce((n, r) => n + (r.findings ? r.findings.length : 0), 0)}`)

phase('Synthesize')
const final = await agent(
  `あなたは 4 reviewer の結果を統合する coordinator です。各 reviewer の構造化 findings (JSON) を渡します。
重複は最も強く具体的な版に統合し、矛盾は解決し、低確度は「残留リスク」に置く。weak finding を埋め草で作らない。

reviewer 結果 (JSON):
${JSON.stringify(valid, null, 2)}

レビュー対象は ${worktree} の \`${diffRange}\`。追加コンテキスト:
${extra}

次の形式・**自然で具体的な日本語**で最終レビューを出力する (file 証拠は Markdown link でなく plain な file:line):

## Reviewed by
- 使った reviewer を 1 行ずつ (何を見たか)。

## 新規または拡大した指摘
- この差分に起因するものだけ。種別は「新規バグ」または「既存問題の露出拡大」。重大度順、各先頭に [P0-P3]。
- 各 finding は: 一言要約 / 種別 / Confidence / どんなときに起きるか / 何が困るか / なぜ起きるか / 根拠(file:line) / どう直すか。

## 総評
- 平易な日本語 3〜6 行。差分起因の問題だけで patch が安全そうか。最も自信がある所/ない所。

## 既存の無関係な問題
- 差分と無関係だが確認できた既存問題のみ。総合評価に含めない旨を明記。

## 残留リスク / 未確認点

## Patch verdict
- overall: correct / mostly correct / incorrect / cannot judge without spec
- reason: 新規バグと差分拡大問題のみに基づく 1 段落。

指摘が無ければ明記する。ファイルは変更しない。`,
  { label: 'synthesize', phase: 'Synthesize', agentType: 'general-purpose' },
)

return final
