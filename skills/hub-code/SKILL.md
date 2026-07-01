# hub-code

This skill lets you navigate and understand a codebase from Slack.

Use the filesystem and bash tools to inspect code.

Commands you may run:
- `read <path>` to read a file.
- `find . -type f -name "*.ts" | head -20` to list files.
- `grep -R "export function" src/ | head -20` to find symbols.

Always quote paths that contain spaces. Prefer reading small, focused files over huge logs.
