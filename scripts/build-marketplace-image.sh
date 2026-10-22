#!/usr/bin/env bash
set -euo pipefail

image_tag="${1:-privos-onboarding:local}"
mapfile -t manifest_values < <(node --input-type=module <<'NODE'
import crypto from 'node:crypto';
import fs from 'node:fs';

function canonicalize(value) {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value && typeof value === 'object') {
		return Object.fromEntries(Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, child]) => [key, canonicalize(child)]));
	}
	return value;
}

const manifest = JSON.parse(fs.readFileSync('privos-app.json', 'utf8'));
const canonical = JSON.stringify(canonicalize(manifest));
const digest = `sha256:${crypto.createHash('sha256').update(canonical).digest('hex')}`;
process.stdout.write(`${Buffer.from(canonical).toString('base64')}\n${digest}\n`);
NODE
)

manifest_json="$(printf '%s' "${manifest_values[0]}" | base64 -d)"
manifest_digest="${manifest_values[1]}"
docker build \
	--build-arg "PRIVOS_MCP_MANIFEST_JSON=${manifest_json}" \
	--build-arg "PRIVOS_MCP_MANIFEST_DIGEST=${manifest_digest}" \
	-t "$image_tag" .

actual_manifest="$(docker image inspect "$image_tag" --format '{{ index .Config.Labels "io.privos.mcp.manifest" }}')"
actual_digest="$(docker image inspect "$image_tag" --format '{{ index .Config.Labels "io.privos.mcp.manifest-digest" }}')"
[[ "$actual_manifest" == "$manifest_json" ]] || { echo 'embedded manifest differs from canonical manifest' >&2; exit 1; }
[[ "$actual_digest" == "$manifest_digest" ]] || { echo 'embedded manifest digest differs from canonical digest' >&2; exit 1; }
echo "image=${image_tag} manifestDigest=${manifest_digest}"
