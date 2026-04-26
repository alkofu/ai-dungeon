# MesloLGS NF — Vendored Font Assets

## Provenance

All four faces were downloaded on **2026-04-26** from the official
Powerlevel10k media repository:

```
https://github.com/romkatv/powerlevel10k-media/raw/master/
```

| File                          | Size (bytes) | SHA-256                                                            |
| ----------------------------- | ------------ | ------------------------------------------------------------------ |
| `MesloLGS NF Regular.ttf`     | 2 594 368    | `d97946186e97f8d7c0139e8983abf40a1d2d086924f2c5dbf1c29bd8f2c6e57d` |
| `MesloLGS NF Bold.ttf`        | 2 603 868    | `b6c0199cf7c7483c8343ea020658925e6de0aeb318b89908152fcb4d19226003` |
| `MesloLGS NF Italic.ttf`      | 2 553 260    | `6f357bcbe2597704e157a915625928bca38364a89c22a4ac36e7a116dcd392ef` |
| `MesloLGS NF Bold Italic.ttf` | 2 561 984    | `56b4131adecec052c4b324efb818dd326d586dbc316fc68f98f1cae2eb8d1220` |

Total on disk: ~10.3 MB (4 faces).

All four faces are vendored. Regular + Bold are the minimum required for
correct powerline glyph rendering; Italic and Bold Italic are included
because zsh prompts and TUI tools (vim status lines, tmux) emit italic SGR
sequences — falling back to Regular for italic spans causes visible
alignment drift in the same prompt where we are fixing alignment. The
~5 MB saving from shipping only two faces is not justified once we accept
the binary-blob trade-off at all.

## License

MesloLGS NF is distributed under the **SIL Open Font License 1.1**.
See the upstream repository for the full licence text:
<https://github.com/romkatv/powerlevel10k/blob/master/font.md>

## Why vendored (not LFS, not subsetting, not CDN)

**Git LFS** was considered and rejected. It adds a clone-time dependency on
the LFS endpoint, complicates contributor onboarding (`git lfs install`
prerequisite), and the assets are immutable once vendored so the normal LFS
benefit (history-trimming of churning blobs) does not apply.

**Font subsetting** (e.g., pyftsubset to keep only the glyph ranges
Powerlevel10k actually emits) was considered and rejected. Subsetting would
shrink each file to ~200–400 KiB but requires either a build-time subsetting
step (toolchain burden) or shipping a pre-subsetted blob that silently breaks
if a future p10k release adds glyphs outside the subset. The correctness
fragility outweighs the size win for an app whose installed binary is already
~10× larger than these font files.

**Runtime download from CDN** was rejected. Tauri apps must run offline;
this is non-negotiable.

For the full reasoning see the plan file referenced in issue #32.
