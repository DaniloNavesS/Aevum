#!/usr/bin/env bash
set -euo pipefail
if ! command -v gnome-shell >/dev/null 2>&1; then
    echo 'GNOME Shell not found. Run this installer on a Fedora system with GNOME.' >&2
    exit 1
fi
shell_version="$(gnome-shell --version)"
if [[ ! "$shell_version" =~ (^|[[:space:]])48\. ]]; then
    echo "This package targets GNOME 48. Detected: $shell_version" >&2
    exit 1
fi
source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
extension_id='aevum@local'
legacy_extension_id='naves-dashboard@local'
extensions_dir="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions"
extension_dir="$extensions_dir/$extension_id"
for asset in metadata.json extension.js stylesheet.css; do
    [[ -f "$source_dir/$asset" ]] || { echo "Missing file: $asset" >&2; exit 1; }
done
backup_dir="${XDG_STATE_HOME:-$HOME/.local/state}/aevum/backups/$(date +%Y%m%d-%H%M%S)-$$"
for installed_id in "$legacy_extension_id" "$extension_id"; do
    installed_dir="$extensions_dir/$installed_id"
    if [[ -d "$installed_dir" ]]; then
        if command -v gnome-extensions >/dev/null 2>&1; then
            gnome-extensions disable "$installed_id" 2>/dev/null || true
        fi
        mkdir -p -- "$backup_dir"
        mv -- "$installed_dir" "$backup_dir/$installed_id"
        echo "Previous installation backed up to: $backup_dir/$installed_id"
    fi
done
legacy_appearance="${XDG_CONFIG_HOME:-$HOME/.config}/naves-dashboard/appearance.json"
appearance="${XDG_CONFIG_HOME:-$HOME/.config}/aevum/appearance.json"
if [[ -f "$legacy_appearance" && ! -e "$appearance" ]]; then
    mkdir -p -- "$(dirname -- "$appearance")"
    cp -p -- "$legacy_appearance" "$appearance"
    echo "Appearance settings copied to: $appearance"
fi
mkdir -p -- "$extension_dir"
for asset in metadata.json extension.js stylesheet.css; do
    install -m 0644 -- "$source_dir/$asset" "$extension_dir/$asset"
done
for translation in "$source_dir"/locale/*/LC_MESSAGES/aevum.mo; do
    [[ -f "$translation" ]] || continue
    language="$(basename -- "$(dirname -- "$(dirname -- "$translation")")")"
    mkdir -p -- "$extension_dir/locale/$language/LC_MESSAGES"
    install -m 0644 -- "$translation" "$extension_dir/locale/$language/LC_MESSAGES/aevum.mo"
done
echo "Files installed in: $extension_dir"
echo
echo '1. Save your work and log out through the GNOME menu.'
echo '2. Log back in.'
echo "3. Run: gnome-extensions enable $extension_id"
echo '4. Click the date and time in the top bar.'
echo
echo "To restore the default: gnome-extensions disable $extension_id"
