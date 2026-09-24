# RTK

RTK (Rust Token Killer, rtk-ai/rtk) ships with Harness in tools/bin, which Harness puts first on PATH for every worker on Windows and Linux. Prefix shell commands with rtk. Use rtk proxy for raw output or commands without a formatter. Examples: rtk git status; rtk proxy cmake --build build; rtk proxy rg -n pattern src. ripgrep (rg) is bundled the same way. If rtk or rg is missing, report that the Harness tools need reinstalling (npm ci or node tools/fetch.cjs in the Harness folder) and use native commands meanwhile; do not install system copies.
