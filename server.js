import express from 'express';
import puppeteer from 'puppeteer';

const app = express();
app.use(express.json());

const API_SECRET = process.env.RAILWAY_API_SECRET;

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
    await new Promise(r => setTimeout(r, 6000));

    const data = await page.evaluate(() => {
      // Méthode 1 : window.runParams avec regex flexible
      try {
        const scripts = Array.from(document.querySelectorAll('script'));
        for (const s of scripts) {
          const text = s.textContent;
          if (text.includes('window.runParams')) {
            // Regex plus flexible sans \n final
            const match = text.match(/window\.runParams\s*=\s*(\{[\s\S]+?\});/);
            if (match) {
              const json = JSON.parse(match[1]);
              const d = json?.data;
              const title = d?.titleModule?.subject;
              const price = d?.priceModule?.minAmount?.value
                         || d?.priceModule?.minPrice?.value
                         || d?.priceModule?.formatedActivityPrice
                         || d?.priceModule?.formatedPrice;
              const images = d?.imageModule?.imagePathList;
              if (title) {
                return {
                  name: title,
                  price_usd: price ? parseFloat(String(price).replace(/[^\d.]/g, '')) || null : null,
                  image_url: images?.[0] ? `https:${images[0]}` : null
                };
              }
            }
          }
        }
      } catch(e) {}

      // Méthode 2 : __NEXT_DATA__ ou données JSON inline
      try {
        const nextData = document.getElementById('__NEXT_DATA__');
        if (nextData) {
          const json = JSON.parse(nextData.textContent);
          const props = json?.props?.pageProps;
          const title = props?.title || props?.productInfo?.title;
          const price = props?.price || props?.productInfo?.price;
          if (title) {
            return {
              name: title,
              price_usd: price ? parseFloat(String(price).replace(/[^\d.]/g, '')) || null : null,
              image_url: null
            };
          }
        }
      } catch(e) {}

      // Méthode 3 : Fallback DOM
      const h1 = document.querySelector('h1');
      const img = document.querySelector('.magnifier-image')
               || document.querySelector('img[src*="ae01.alicdn"]')
               || document.querySelector('img[src*="aliexpress"]');
      const priceEl = document.querySelector('.product-price-value')
                   || document.querySelector('[class*="uniform-banner-box-price"]')
                   || document.querySelector('[class*="price--current"]')
                   || document.querySelector('[data-pl="product-price"]');

      return {
        name: h1?.textContent?.trim() || null,
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
