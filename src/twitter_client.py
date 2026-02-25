import asyncio
import json
import sys
import os
import time
import random

COOKIES_FILE = '/tmp/twitter_session.json'
CHROMIUM_PATH = '/nix/store/qa9cnw4v5xkxyip6mb9kxqfq1z4x2dx1-chromium-138.0.7204.100/bin/chromium'

def find_chromium():
    import shutil
    path = shutil.which('chromium')
    if path:
        return path
    if os.path.exists(CHROMIUM_PATH):
        return CHROMIUM_PATH
    return None

def get_browser_args():
    return [
        '--no-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
    ]

async def run_action(action, args):
    from playwright.async_api import async_playwright

    chromium_path = find_chromium()
    if not chromium_path:
        return {"success": False, "error": "Chromium not found"}

    username = os.environ.get('TWITTER_USERNAME', '')
    email = os.environ.get('TWITTER_EMAIL', '')
    password = os.environ.get('TWITTER_PASSWORD', '')

    if not username or not password:
        return {"success": False, "error": "Missing TWITTER_USERNAME or TWITTER_PASSWORD"}

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            executable_path=chromium_path,
            args=get_browser_args()
        )

        context_opts = {
            'user_agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            'viewport': {'width': 1920, 'height': 1080},
            'locale': 'en-US',
        }

        if os.path.exists(COOKIES_FILE):
            context_opts['storage_state'] = COOKIES_FILE

        context = await browser.new_context(**context_opts)
        page = await context.new_page()

        try:
            logged_in = await ensure_login(page, context, username, email, password)
            if not logged_in["success"]:
                await browser.close()
                return logged_in

            if action == "login":
                result = logged_in

            elif action == "tweet":
                if not args:
                    result = {"success": False, "error": "No tweet text provided"}
                else:
                    result = await post_tweet(page, args[0])

            elif action == "reply":
                if len(args) < 2:
                    result = {"success": False, "error": "Need tweet_id and text"}
                else:
                    result = await reply_to_tweet(page, args[0], args[1])

            else:
                result = {"success": False, "error": f"Unknown action: {action}"}

            await context.storage_state(path=COOKIES_FILE)

        except Exception as e:
            result = {"success": False, "error": str(e)}

        await browser.close()
        return result


async def ensure_login(page, context, username, email, password):
    try:
        await page.goto('https://x.com/home', wait_until='domcontentloaded', timeout=30000)
        await page.wait_for_timeout(3000)

        current_url = page.url
        if '/home' in current_url and 'login' not in current_url:
            try:
                await page.wait_for_selector('[data-testid="primaryColumn"]', timeout=5000)
                return {"success": True, "source": "cookies", "username": username}
            except Exception:
                pass

        await page.goto('https://x.com/i/flow/login', wait_until='domcontentloaded', timeout=30000)
        await page.wait_for_timeout(3000)

        username_input = await page.wait_for_selector('input[autocomplete="username"]', timeout=15000)
        await page.wait_for_timeout(random.uniform(0.5, 1.5) * 1000)
        await username_input.type(username, delay=random.randint(50, 150))
        await page.wait_for_timeout(random.uniform(0.5, 1.0) * 1000)

        next_buttons = await page.query_selector_all('button')
        for btn in next_buttons:
            text = await btn.inner_text()
            if 'Next' in text or 'next' in text:
                await btn.click()
                break
        await page.wait_for_timeout(2000)

        email_input = await page.query_selector('input[data-testid="ocfEnterTextTextInput"]')
        if email_input:
            await email_input.type(email, delay=random.randint(50, 150))
            await page.wait_for_timeout(500)
            next_btn2 = await page.query_selector('[data-testid="ocfEnterTextNextButton"]')
            if next_btn2:
                await next_btn2.click()
            else:
                buttons = await page.query_selector_all('button')
                for btn in buttons:
                    text = await btn.inner_text()
                    if 'Next' in text:
                        await btn.click()
                        break
            await page.wait_for_timeout(2000)

        password_input = await page.wait_for_selector('input[type="password"]', timeout=10000)
        await page.wait_for_timeout(random.uniform(0.5, 1.0) * 1000)
        await password_input.type(password, delay=random.randint(50, 150))
        await page.wait_for_timeout(random.uniform(0.5, 1.0) * 1000)

        login_btn = await page.query_selector('[data-testid="LoginForm_Login_Button"]')
        if login_btn:
            await login_btn.click()
        await page.wait_for_timeout(5000)

        current_url = page.url
        if '/home' in current_url:
            return {"success": True, "source": "fresh_login", "username": username}

        error_el = await page.query_selector('[data-testid="error-detail"]')
        if error_el:
            error_text = await error_el.inner_text()
            return {"success": False, "error": f"Login error: {error_text}"}

        return {"success": True, "source": "login_attempted", "url": current_url, "username": username}

    except Exception as e:
        return {"success": False, "error": f"Login failed: {str(e)}"}


async def post_tweet(page, text):
    try:
        await page.goto('https://x.com/home', wait_until='domcontentloaded', timeout=30000)
        await page.wait_for_timeout(3000)

        tweet_box = await page.wait_for_selector('[data-testid="tweetTextarea_0"]', timeout=10000)
        await tweet_box.click()
        await page.wait_for_timeout(500)

        await page.keyboard.type(text, delay=random.randint(30, 80))
        await page.wait_for_timeout(1000)

        post_btn = await page.wait_for_selector('[data-testid="tweetButtonInline"]', timeout=5000)
        await post_btn.click()
        await page.wait_for_timeout(3000)

        return {"success": True, "text": text, "timestamp": time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}

    except Exception as e:
        return {"success": False, "error": f"Tweet failed: {str(e)}"}


async def reply_to_tweet(page, tweet_url, text):
    try:
        if not tweet_url.startswith('http'):
            tweet_url = f'https://x.com/i/status/{tweet_url}'

        await page.goto(tweet_url, wait_until='domcontentloaded', timeout=30000)
        await page.wait_for_timeout(3000)

        reply_box = await page.wait_for_selector('[data-testid="tweetTextarea_0"]', timeout=10000)
        await reply_box.click()
        await page.wait_for_timeout(500)

        await page.keyboard.type(text, delay=random.randint(30, 80))
        await page.wait_for_timeout(1000)

        reply_btn = await page.wait_for_selector('[data-testid="tweetButtonInline"]', timeout=5000)
        await reply_btn.click()
        await page.wait_for_timeout(3000)

        return {"success": True, "reply_to": tweet_url, "text": text, "timestamp": time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}

    except Exception as e:
        return {"success": False, "error": f"Reply failed: {str(e)}"}


async def main():
    if len(sys.argv) < 2:
        print(json.dumps({"success": False, "error": "No action specified. Usage: python twitter_client.py <login|tweet|reply> [args...]"}))
        return

    action = sys.argv[1]
    args = sys.argv[2:]

    result = await run_action(action, args)
    print(json.dumps(result))


if __name__ == "__main__":
    asyncio.run(main())
