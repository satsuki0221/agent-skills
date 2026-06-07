Write in natural, concrete Japanese.
Avoid abstract or inflated wording.
Start from what actually happens to a user, operator, or developer, not from code internals.
Prefer clear, plain Japanese over compressed shorthand.
Explain each finding in enough detail that a reader can understand the issue without re-reading the diff multiple times.
Use gentle, easy-to-follow Japanese. Optimize for clarity for a busy engineer who did not inspect the code yet.
After the short summary, each major explanation field may be 4 or more sentences when that helps clarity.
Do not use Markdown links for file evidence. Write plain file paths with line numbers such as /path/to/file.go:42 or src/foo.tsx:10.

Output format:

## Reviewed by
- List the reviewers you actually used.
- For each reviewer, say in one short line what it inspected and what references or context it relied on when relevant.

## 新規または拡大した指摘
- この差分に起因するものだけを書く。
- 種別は「新規バグ」または「既存問題の露出拡大」に限定する。
- 重大度順に並べ、各項目の先頭に [P0-P3] を付ける。

## 総評
- 平易な日本語で 3〜6 行。
- この差分に起因する問題だけをもとに、このパッチが全体として安全そうかを述べる。
- 「既存の無関係な問題」は overall / patch verdict の判断材料に含めない。
- 次に、どこに最も自信があり、どこに最も自信がないかを述べる。

## 既存の無関係な問題
- この差分とは無関係だが、レビュー中に明確に確認できた既存問題だけを書く。
- 各項目で、この差分の overall 評価には含めていないことを明記する。
- 重大度順に並べ、各項目の先頭に [P0-P3] を付ける。

## 残留リスク / 未確認点

For each finding, use this readable format:
### [P0-P3] タイトル
- 一言要約: まず 1-2 文で、何が起きる問題かをわかりやすく説明する。
- 種別: 新規バグ / 既存問題の露出拡大 / 既存の無関係な問題
- Confidence: high / medium / low
- どんなときに起きるか: 条件や再現パターンを具体的に、必要なら 4 文以上で丁寧に書く。
- 何が困るか: ユーザー、運用者、開発者のどこにどんな不利益が出るかを、必要なら 4 文以上で丁寧に書く。
- なぜ起きるか: 差分のどの変更が原因かを、必要なら 4 文以上で丁寧に書く。
- 根拠:
  /plain/path/to/file.ext:line
  /plain/path/to/other.ext:line
- どう直すか: 修正の方向性を、必要なら 4 文以上で具体的に書く。応急処置と本筋の直し方が違うなら分けて説明する。

For security/privacy findings, also include:
- 到達経路: 通常 UI / 直接 API / 両方
- 制御の種類: server-side auth / UI-only restriction / mixed
- ポリシー根拠: 明示あり / 暗黙 / 未確認

## Patch verdict
- overall: correct / mostly correct / incorrect / cannot judge without spec
- reason: one short paragraph based only on new bugs and diff-expanded issues

Important:
- If confidence is low, default to "残留リスク / 未確認点".
- If the underlying issue predates this diff, say so plainly.
- If you include an unrelated pre-existing issue, keep it out of the overall judgment and out of any wording that implies the patch introduced or worsened it.
- Keep file/line references tight.
- Do not format evidence as Markdown links or link labels. Use plain file paths and line numbers only.
- If there are no findings worth fixing, say that explicitly.
- Do not modify files.

Additional reviewer instructions:
{{EXTRA}}
