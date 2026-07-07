from playwright.sync_api import sync_playwright
import requests
import time
import sys

CDP_URL = "http://127.0.0.1:9222"

def find_tabby_page():
    """Find the main Tabby page target."""
    resp = requests.get(f"{CDP_URL}/json")
    targets = resp.json()
    for t in targets:
        if t.get("type") == "page" and "tabby" in t.get("url", "").lower():
            return t
    # fallback: first page target
    for t in targets:
        if t.get("type") == "page":
            return t
    return None

def main():
    with sync_playwright() as p:
        # Connect to existing Electron instance via CDP
        browser = p.chromium.connect_over_cdp(CDP_URL)
        
        # Find the right context/page
        contexts = browser.contexts
        if not contexts:
            print("ERROR: No browser contexts found")
            sys.exit(1)
        
        # Find Tabby's main page
        page = None
        for ctx in contexts:
            for pg in ctx.pages:
                url = pg.url
                print(f"  Page URL: {url}")
                if "tabby" in url.lower() or "file" in url.lower() or "app" in url.lower():
                    page = pg
                    break
            if page:
                break
        
        if not page:
            # Just use the first page
            page = contexts[0].pages[0] if contexts[0].pages else None
        
        if not page:
            print("ERROR: No page found")
            sys.exit(1)
        
        print(f"Connected to page: {page.url}")
        
        # Wait for app to fully load
        page.wait_for_load_state("domcontentloaded")
        time.sleep(3)
        
        # Take initial screenshot
        page.screenshot(path="D:/vibecoding/ssh/new-ssh/test_screenshots/01_initial.png")
        print("Screenshot 01: Initial state saved")
        
        # Find the AI assistant button in the toolbar
        # The button has title "AI 助手" or contains the chat icon SVG
        buttons = page.locator("button, .toolbar-button, [role='button']").all()
        print(f"Found {len(buttons)} clickable elements")
        
        ai_button = None
        for i, btn in enumerate(buttons):
            try:
                title = btn.get_attribute("title") or ""
                text = btn.inner_text() or ""
                aria_label = btn.get_attribute("aria-label") or ""
                combined = f"{title} {text} {aria_label}"
                if "AI" in combined or "助手" in combined or "ai" in combined.lower():
                    print(f"  Candidate button #{i}: title='{title}' text='{text}' aria='{aria_label}'")
                    if ai_button is None:
                        ai_button = btn
            except:
                pass
        
        if not ai_button:
            # Try finding by SVG path or tooltip
            print("Trying alternative search for AI button...")
            all_elements = page.locator("*").all()
            for el in all_elements:
                try:
                    title = el.get_attribute("title") or ""
                    if "AI" in title or "助手" in title:
                        ai_button = el
                        print(f"  Found by title: '{title}'")
                        break
                except:
                    pass
        
        if not ai_button:
            print("ERROR: Could not find AI assistant button")
            # Dump toolbar area for debugging
            page.screenshot(path="D:/vibecoding/ssh/new-ssh/test_screenshots/02_no_button_found.png")
            # Try to get the toolbar HTML
            toolbar_html = page.evaluate("""() => {
                const toolbar = document.querySelector('.toolbar, .window-toolbar, app-window-toolbar');
                return toolbar ? toolbar.innerHTML : 'No toolbar found';
            }""")
            print(f"Toolbar HTML (first 2000 chars): {toolbar_html[:2000]}")
            sys.exit(1)
        
        print(f"Found AI button, clicking...")
        ai_button.click()
        
        # Wait for sidecar to appear
        time.sleep(2)
        
        # Take screenshot after click
        page.screenshot(path="D:/vibecoding/ssh/new-ssh/test_screenshots/03_after_click.png")
        print("Screenshot 03: After AI button click saved")
        
        # Check if sidecar appeared
        sidecar = page.locator("app-command-sidecar, .sidecar, [class*='sidecar']").all()
        print(f"Found {len(sidecar)} sidecar elements after click")
        
        if len(sidecar) > 0:
            # Check if it's visible
            for i, sc in enumerate(sidecar):
                try:
                    visible = sc.is_visible()
                    box = sc.bounding_box()
                    print(f"  Sidecar #{i}: visible={visible}, box={box}")
                except:
                    print(f"  Sidecar #{i}: could not check visibility")
        
        # Also check for any error messages or notifications
        notifications = page.locator(".toast, .notification, .alert").all()
        for n in notifications:
            try:
                text = n.inner_text()
                print(f"  Notification: {text}")
            except:
                pass
        
        # Take final screenshot
        page.screenshot(path="D:/vibecoding/ssh/new-ssh/test_screenshots/04_final.png")
        print("Screenshot 04: Final state saved")
        
        browser.close()

if __name__ == "__main__":
    import os
    os.makedirs("D:/vibecoding/ssh/new-ssh/test_screenshots", exist_ok=True)
    main()
