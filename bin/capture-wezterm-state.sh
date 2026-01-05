#!/bin/bash
# Captures current WezTerm terminal state (panes, processes, screen content) as JSON

set -euo pipefail

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
OUTPUT_FILE="${1:-$HOME/.wezterm-backup/backup-$TIMESTAMP.json}"
SCROLLBACK_LINES="${2:-100}"

# Ensure output directory exists
mkdir -p "$(dirname "$OUTPUT_FILE")"

# Check dependencies
if ! command -v wezterm &> /dev/null; then
    echo '{"error": "wezterm CLI not found"}' > "$OUTPUT_FILE"
    exit 1
fi

if ! command -v jq &> /dev/null; then
    echo '{"error": "jq not found - install with: brew install jq"}' > "$OUTPUT_FILE"
    exit 1
fi

# Get pane list
PANES_JSON=$(wezterm cli list --format json 2>/dev/null) || {
    echo '{"error": "Failed to connect to WezTerm. Is WezTerm running?"}' > "$OUTPUT_FILE"
    exit 1
}

# Build output with screen content for each pane
RESULT=$(echo "$PANES_JSON" | jq -c '.[]' | while read -r pane; do
    PANE_ID=$(echo "$pane" | jq -r '.pane_id')

    # Capture screen content (visible area + scrollback)
    SCREEN_CONTENT=$(wezterm cli get-text --pane-id "$PANE_ID" --start-line "-$SCROLLBACK_LINES" 2>/dev/null || echo "[failed to capture]")

    # Escape the content for JSON and add to pane object
    echo "$pane" | jq --arg content "$SCREEN_CONTENT" '. + {screen_content: $content}'
done | jq -s '.')

# Create final output
jq -n \
    --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --argjson panes "$RESULT" \
    '{
        captured_at: $timestamp,
        pane_count: ($panes | length),
        panes: $panes
    }' > "$OUTPUT_FILE"

echo "Captured WezTerm state to: $OUTPUT_FILE"
echo "Panes captured: $(echo "$RESULT" | jq 'length')"
