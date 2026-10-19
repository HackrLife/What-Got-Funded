# Renders public/editions/<day>/*.svg to PNG at 2x for email.  python3 render-charts.py 2026-10-18
import sys, pathlib, asyncio
from playwright.async_api import async_playwright
day = sys.argv[1]
d = pathlib.Path(__file__).parent / "public" / "editions" / day
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await b.new_page(device_scale_factor=2)
        for svg in sorted(d.glob("*.svg")):
            await pg.set_content(f'<html><body style="margin:0;background:#fff"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;700;800&display=swap">{svg.read_text()}</body></html>')
            await pg.wait_for_timeout(600)
            el = await pg.query_selector("svg")
            await el.screenshot(path=str(svg.with_suffix(".png")))
            print("wrote", svg.with_suffix(".png"))
        await b.close()
asyncio.run(main())
