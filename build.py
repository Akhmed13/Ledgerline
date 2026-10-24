"""Rebuild index.html (the standalone site) from src/ledgerline.html (the Claude artifact source)."""
from pathlib import Path

HEAD = (
    '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
    '<style>:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);'
    'padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0;font:14px system-ui,-apple-system,'
    '"Segoe UI",sans-serif}img{max-width:100%}[hidden]{display:none!important}</style>\n</head>\n<body>\n'
)
root = Path(__file__).parent
body = (root / 'src' / 'ledgerline.html').read_text(encoding='utf-8')
(root / 'index.html').write_text(HEAD + body + '\n</body>\n</html>\n', encoding='utf-8')
print('index.html rebuilt')
