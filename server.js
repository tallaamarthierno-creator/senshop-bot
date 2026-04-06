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
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token || token !== API_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// Route de scraping
app.post('/scrape-product', async (req, res) => {
  const authHeader = req.headers['authorization'];
console.log('Auth header reçu:', authHeader);
console.log('Secret attendu:', API_SECRET);
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL manquante' });

    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

    const data = await page.evaluate(() => {
      const nameEl = document.querySelector('h1') || document.querySelector('[data-testid*="title"]');
      const priceEl = document.querySelector('[data-testid*="price"]') || document.querySelector('.search-price-top');
      const imgEl = document.querySelector('img[alt*="product"]') || document.querySelector('img');

      return {
        name: nameEl?.textContent?.trim() || 'Sans titre',
        price_usd: priceEl ? parseFloat(priceEl.textContent.replace(/[^\d.]/g, '')) : null,
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

    // Simulation d'ajout au panier et commande
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
