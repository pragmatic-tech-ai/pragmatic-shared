#!/usr/bin/env bash
# Checks that each image carries the component descriptor its label names: the sha256 of /pragmatic/component.json inside
# the image equals the ai.pragmatic-tech.component.digest label. Usage: check-component-label.sh <image>...
# Prints one line per image; exits 1 when any image has no label, no descriptor (file=missing), or a mismatch. An image
# that cannot be inspected is named the same way (label=none) and the next image is still checked.
set -euo pipefail

label_name='ai.pragmatic-tech.component.digest'
descriptor_path='/pragmatic/component.json'
# The descriptor's bytes go to a file, never through a command substitution (which would drop its trailing newline).
descriptor="$(mktemp)"
trap 'rm -f "$descriptor"' EXIT
status=0
for image in "$@"; do
    if ! label="$(docker image inspect --format "{{ index .Config.Labels \"$label_name\" }}" "$image")"; then
        label=''
    fi
    if ! docker run --rm --network none --entrypoint cat "$image" "$descriptor_path" > "$descriptor"; then
        echo "MISMATCH $image label=${label:-none} file=missing" >&2
        status=1
        continue
    fi
    content="$(sha256sum "$descriptor" | cut -d ' ' -f 1)"
    if [[ "$label" =~ ^sha256:[0-9a-f]{64}$ && "$label" == "sha256:$content" ]]; then
        echo "ok $image $label"
    else
        echo "MISMATCH $image label=${label:-none} file=sha256:$content" >&2
        status=1
    fi
done
exit "$status"
