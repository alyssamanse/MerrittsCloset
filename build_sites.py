"""Build extra wishlist sites from the main page, so they always share the same code.

Run after stamp.py on every publish:  python3 build_sites.py <repo dir>
Each site is a folder (e.g. luca/) whose index.html is the main index.html with:
  • its own title / share preview / icon,
  • window.CLOSET_SITE set, which picks its settings in config.js,
  • its own colors layered over the main theme,
  • script and image paths pointing back to the shared files.
"""
import re, sys, pathlib

SITES = {
    "luca": {
        "title": "Luca's Wishlist",
        "description": "Gift ideas for Luca. Claim a gift so nobody doubles up.",
        "url": "https://alyssamanse.github.io/MerrittsCloset/luca/",
        "image_alt": "An L monogram with a tiny sailboat above the words Luca's Wishlist",
        "theme_color": "#F3F6F7",
        # Coastal: harbor blue, sea glass, sand, misty white.
        "css": """
  :root {
    --paper: #F3F6F7; --surface: #FCFDFD; --ink: #1F3340; --taupe: #647884; --line: #D9E3E8;
    --rose: #2E5E7E; --cocoa: #284F69; --rose-lt: #E2EDF3; --blush: #DAE7EE; --blush-2: #B5CCDA;
    --moss: #4C7D76; --moss-lt: #DFEEEA; --hazel: #DCCFB8; --on-rose: #FFFFFF;
    --shadow: 0 1px 2px rgba(31,51,64,.06);
  }
  .toast-btn { color: #BFE0F2; }
  .chip.warn { background: #F6E9D6; color: #7A5418; }
""",
    },
}

def build(root):
    root = pathlib.Path(root)
    src = (root / "index.html").read_text()
    for key, s in SITES.items():
        html = src
        def meta(attr, name, value):
            nonlocal html
            html = re.sub(rf'(<meta {attr}="{re.escape(name)}" content=")[^"]*(")', lambda m: m.group(1) + value + m.group(2), html, count=1)
        html = re.sub(r"<title>[^<]*</title>", f"<title>{s['title']}</title>", html, count=1)
        meta("name", "theme-color", s["theme_color"])
        meta("name", "description", s["description"])
        meta("property", "og:title", s["title"])
        meta("property", "og:description", s["description"])
        meta("property", "og:url", s["url"])
        meta("property", "og:image", s["url"] + "share.png")
        meta("property", "og:image:alt", s["image_alt"])
        # Shared code lives one folder up; images (icon, QR, share card) are the site's own.
        html = re.sub(r'src="app\.js\?v=([^"]+)"', r'src="../app.js?v=\1"', html)
        html = html.replace('<script type="module" src="../app.js', f'<script>window.CLOSET_SITE = "{key}";</script>\n  <script type="module" src="../app.js', 1)
        html = html.replace("</head>", f"<style>/* {key}: site colors */{s['css']}</style>\n</head>", 1)
        out = root / key
        out.mkdir(exist_ok=True)
        (out / "index.html").write_text(html)
        print(f"built {key}/index.html")

if __name__ == "__main__":
    build(sys.argv[1] if len(sys.argv) > 1 else ".")
