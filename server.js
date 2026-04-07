import express from 'express';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteer.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 3000;
const API_SECRET = process.env.RAILWAY_API_SECRET || 'test_secret';

app.use(express.json());

// Middleware d'authentification
app.use((req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader?.split(' ')[1];
  
  console.log('🔍 Auth header reçu:', authHeader);
  console.log('🔍 Token extrait:', token);
  console.log('🔍 Secret attendu:', API_SECRET);
  console.log('🔍 Correspondent?', token === API_SECRET);
  
  if (!token || token !== API_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// Route de scraping
app.post('/scrape-product', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL manquante' });

    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 3000)); // attendre le JS

    const data = await page.evaluate(() => {
      // Nom du produit
      const nameEl = document.querySelector('h1[data-pl="product-title"]')
        || document.querySelector('.product-title-text')
        || document.querySelector('h1');

      // Prix
      const priceEl = document.querySelector('.product-price-value')
        || document.querySelector('[class*="product-price"]')
        || document.querySelector('.uniform-banner-box-price');

      let price_usd = null;
      if (priceEl) {
        const raw = priceEl.textContent.replace(/[^\d.]/g, '');
        price_usd = raw ? parseFloat(raw) : null;
      }

      // Image principale
      const imgEl = document.querySelector('.magnifier-image')
        || document.querySelector('img.J_img-base')
        || document.querySelector('[class*="slider"] img')
        || document.querySelector('.images-view-item img')
        || document.querySelector('img');

      return {
        name: nameEl?.textContent?.trim() || 'Sans titre',
        price_usd,
        image_url: imgEl?.src || null
      };
    });

    await browser.close();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Route de commande
app.post('/place-order', async (req, res) => {
  try {
    const { aliexpress_url, quantity, shipping_address, order_id } = req.body;
    
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.goto(aliexpress_url, { waitUntil: 'networkidle2', timeout: 30000 });

    await page.click('[data-testid="quantity-input"]').catch(() => {});
    await page.type('[data-testid="quantity-input"]', String(quantity)).catch(() => {});
    
    const orderNumber = `ALI-${Date.now()}`;
    await browser.close();

    res.json({
      success: true,
      aliexpress_order_id: orderNumber,
      message: 'Commande passée avec succès'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Serveur lancé sur le port ${PORT}`);
});
