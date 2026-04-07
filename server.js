import express from 'express';
import puppeteer from 'puppeteer';

const app = express();
app.use(express.json());

const API_SECRET = process.env.API_SECRET;

app.use((req, res, next) => {
  const auth = req.headers['authorization'];
  if (!auth || auth !== `Bearer ${API_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

app.post('/scrape-product', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL manquante' });

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise(r => setTimeout(r, 5000));

    const data = await page.evaluate(() => {
      // Extraire depuis window.runParams (JSON AliExpress)
      try {
        const scripts = Array.from(document.querySelectorAll('script'));
        for (const s of scripts) {
          if (s.textContent.includes('window.runParams')) {
            const match = s.textContent.match(/window\.runParams\s*=\s*(\{[\s\S]+?\});\s*\n/);
            if (match) {
              const json = JSON.parse(match[1]);
              const title = json?.data?.titleModule?.subject;
              const price = json?.data?.priceModule?.minAmount?.value;
              const images = json?.data?.imageModule?.imagePathList;
              return {
                name: title || null,
                price_usd: price ? parseFloat(price) : null,
                image_url: images?.[0] ? `https:${images[0]}` : null
              };
            }
          }
        }
      } catch(e) {}

      // Fallback DOM
      const h1 = document.querySelector('h1');
      const img = document.querySelector('.magnifier-image') || document.querySelector('img[src*="aliexpress"]');
      const priceEl = document.querySelector('.product-price-value') || document.querySelector('[class*="price"]');
      
      return {
        name: h1?.textContent?.trim() || 'Sans titre',
        price_usd: priceEl ? parseFloat(priceEl.textContent.replace(/[^\d.]/g, '')) || null : null,
        image_url: img?.src || null
      };
    });

    await browser.close();
    res.json(data);
  } catch (error) {
    if (browser) await browser.close().catch(() => {});
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur démarré sur le port ${PORT}`));
