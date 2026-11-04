# Release trees inside an install folder (docs/agent-boxes.md §9.1). An install folder holds one
# release's files plus things that belong to the install, not to a release: .env.prod, backups,
# .releases/ (earlier releases), .git, node_modules and the installer's own records. Upgrades and
# rollbacks move a whole release out (into .releases/<version>-<time>/) before putting the other
# in, so no file of one release (a migration, say) survives into the other.

# Paths, relative to the install folder, that are never part of a release
release_prune_args() {
    printf '%s\n' \
        -path ./.git -o -path ./.releases -o -path ./backups -o -path ./data -o -name node_modules \
        -o -path ./.env -o -path ./.env.prod -o -path './.env.prod.*' \
        -o -path ./.agora-install -o -path ./.agora-url -o -path ./.agora-upgrade -o -path ./.claude
}

# release_files <dir>: every file and symlink of the release in <dir>, NUL-separated, relative
release_files() {
    local args=()
    mapfile -t args < <(release_prune_args)
    (cd "$1" && find . \( "${args[@]}" \) -prune -o \( -type f -o -type l \) -print0)
}

# stash_release <dir> <dest>: moves the release in <dir> to <dest> (which must not exist)
stash_release() {
    local dir=$1 dest=$2 f
    [ ! -e "$dest" ] || die "$dest already exists"
    mkdir -p "$dest"
    while IFS= read -r -d '' f; do
        mkdir -p "$dest/$(dirname "$f")"
        mv "$dir/$f" "$dest/$f"
    done < <(release_files "$dir")
    # Directories the release left empty
    local args=()
    mapfile -t args < <(release_prune_args)
    (cd "$dir" && find . -mindepth 1 \( "${args[@]}" \) -prune -o -type d -empty -print0 | xargs -0 -r rmdir -p --ignore-fail-on-non-empty 2>/dev/null) || true
}

# place_release <src> <dir>: copies a release tree into <dir> (whose own release was stashed)
place_release() {
    local src=$1 dir=$2 left
    left=$(release_files "$dir" | tr '\0' '\n' | head -n 3)
    [ -z "$left" ] || die "internal: $dir still has release files ($left); stash them first"
    tar -C "$src" --exclude=./.git --exclude='*/node_modules' --exclude=./node_modules --exclude=./.releases \
        --exclude=./backups --exclude=./.env --exclude=./.env.prod --exclude='./.env.prod.*' --exclude=./.claude \
        --exclude=./.agora-install --exclude=./.agora-url --exclude=./.agora-upgrade -cf - . | tar -C "$dir" -xf -
}
