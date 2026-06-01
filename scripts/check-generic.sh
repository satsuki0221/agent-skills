#!/usr/bin/env bash
# 共通 repo の skill に project 固有 token が混入していないか確認する gate。
# 各 skill (<name>/SKILL.md) は脱-project であるべき (固有値は consumer 側 local.md へ)。
set -uo pipefail
ROOT="$(git rev-parse --show-toplevel)"
# project 固有 token: matchjournal 由来の名称 / deploy コマンド / GOLDEN_RULES ID /
# 3 桁 issue 番号 / YYYY-MM-DD 日付 (provenance)。R2 は Round-2 表記と衝突するため
# Cloudflare R2 を指す文脈 (R2 bucket / R2 保存 等) のみを対象にする。
# 注: "Phase N" は devteam 自身の roadmap 段階表記 (汎用) なので除外。matchjournal の
# Phase 4 Turso 等は "Turso" 側で捕まる。"[Tt]urso" は大小文字両方を弾く (TURSO だけだと
# turso-green 等の小文字 worktree 名を見逃した、PR #724 codex P2-3)。
PATTERN='matchjournal|[Tt]urso|test-db-port|fly deploy|wrangler|\bcombo\b|SF6|Neon|R2 (bucket|保存|storage|削除)|G-(harness|ci|skill|py|fe)-[0-9]+|#[0-9]{3}|20[0-9]{2}-[0-9]{2}-[0-9]{2}'
hits=$(grep -rnE "$PATTERN" "$ROOT"/*/SKILL.md 2>/dev/null || true)
if [[ -n "$hits" ]]; then
  echo "FAIL: project-specific tokens found in shared skills:" >&2
  echo "$hits" >&2
  echo "" >&2
  echo "固有値は consumer 側の <repo>/harness/<skill>.local.md に置くこと。" >&2
  exit 1
fi
echo "OK: no project-specific tokens in shared skills"
