import express from 'express';
import { chromium } from 'playwright';

const app = express();
app.use(express.json());

const API_SECRET = process.env.RAILWAY_API_SECRET;

// Route de debug AVANT le middleware d'auth
app.get('/debug-env', (req, res) => {
  res.json({
    ALIEXPRESS_MAIL: !!process.env.ALI_MAIL,
    ALIEXPRESS_PASSWORD: !!process.env.ALIEXPRESS_PASSWORD,
    RAILWAY_API_SECRET: !!process.env.RAILWAY_API_SECRET,
    MAIL_PREVIEW: (process.env.ALI_MAIL || '').substring(0, 10),
    SECRET_PREVIEW: (process.env.RAILWAY_API_SECRET || '').substring(0, 5),
  });
});

app.use((req, res, next) => {
  const auth = req.headers['authorization'];
  if (!auth || auth !== `Bearer ${API_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// Route existante — scraping produit
app.post('/scrape-product', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL manquante' });

  const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY;
  if (!SCRAPER_API_KEY) return res.status(500).json({ error: 'SCRAPER_API_KEY non configurée' });

  try {
    const encodedUrl = encodeURIComponent(url);
    const response = await fetch(`https://api.scraperapi.com/?api_key=${SCRAPER_API_KEY}&url=${encodedUrl}`);
    const html = await response.text();

    const nameMatch = html.match(/<h1[^>]*>([^<]+)<\/h1>/i) || html.match(/"subject":"([^"]+)"/);
    const name = nameMatch?.[1]?.trim() || null;

    const priceMatch = html.match(/"minAmount":\{"value":(\d+\.?\d*)/);
    const price_usd = priceMatch ? parseFloat(priceMatch[1]) : null;

    const imgMatch = html.match(/<meta property="og:image" content="([^"]+)"/i);
    const image_url = imgMatch?.[1] || null;

    res.json({ name, price_usd, image_url });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Helper — trouver un champ dans la page OU dans les iframes
async function findInPageOrFrames(page, selector, timeout = 15000) {
  // Essayer dans la page principale
  try {
    await page.waitForSelector(selector, { timeout: 5000 });
    return { frame: page, found: true };
  } catch {}

  // Essayer dans tous les iframes
  const frames = page.frames();
  for (const frame of frames) {
    try {
      await frame.waitForSelector(selector, { timeout: 3000 });
      return { frame, found: true };
    } catch {}
  }

  return { frame: null, found: false };
}

// Nouvelle route — passer une commande AliExpress automatiquement
app.post('/place-order', async (req, res) => {
  const { aliexpress_url, quantity, shipping_address, order_id, ali_mail, ali_password } = req.body;

  if (!aliexpress_url || !shipping_address) {
    return res.status(400).json({ error: 'aliexpress_url et shipping_address requis' });
  }

  const ALIEXPRESS_MAIL = ali_mail || process.env.ALI_MAIL;
  const ALIEXPRESS_PASSWORD = ali_password || process.env.ALIEXPRESS_PASSWORD;

  if (!ALIEXPRESS_MAIL || !ALIEXPRESS_PASSWORD) {
    return res.status(500).json({ error: 'Identifiants AliExpress non configurés' });
  }

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      locale: 'en-US',
      viewport: { width: 1280, height: 800 }
    });

    const page = await context.newPage();

    // 1. Aller sur aliexpress.com pour les cookies
    console.log('[place-order] Chargement page accueil...');
    await page.goto('https://www.aliexpress.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    // Fermer popup cookie si présent
    try {
      await page.click('button[data-role="accept"], .btn-accept', { timeout: 3000 });
    } catch {}

    // 2. Aller sur la page de login
    console.log('[place-order] Navigation vers login...');
    await page.goto('https://login.aliexpress.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(4000);
    console.log('[place-order] URL login:', page.url());
    console.log('[place-order] Frames disponibles:', page.frames().map(f => f.url()));

    // 3. Chercher les champs dans la page et les iframes
    const emailSelectors = [
      'input[name="loginId"]',
      'input[type="email"]',
      '#fm-login-id',
      'input[placeholder*="mail"]',
      'input[placeholder*="Email"]',
      'input[placeholder*="phone"]',
    ];

    let loginFrame = null;

    // Chercher dans chaque iframe
    const frames = page.frames();
    console.log('[place-order] Nombre de frames:', frames.length);

    for (const frame of frames) {
      console.log('[place-order] Test frame:', frame.url());
      for (const sel of emailSelectors) {
        try {
          const el = await frame.$(sel);
          if (el) {
            console.log('[place-order] Champ email trouvé dans frame:', frame.url(), 'sélecteur:', sel);
            loginFrame = frame;
            break;
          }
        } catch {}
      }
      if (loginFrame) break;
    }

    if (!loginFrame) {
      // Screenshot pour debug
      const screenshot = await page.screenshot({ encoding: 'base64' });
      console.log('[place-order] SCREENSHOT BASE64 (premiers 200 chars):', screenshot.substring(0, 200));
      throw new Error('Champ email introuvable dans aucun frame. Voir logs pour debug.');
    }

    // 4. Remplir email
    for (const sel of emailSelectors) {
      try {
        const el = await loginFrame.$(sel);
        if (el) {
          await loginFrame.fill(sel, ALIEXPRESS_MAIL);
          console.log('[place-order] Email rempli avec:', sel);
          break;
        }
      } catch {}
    }
    await page.waitForTimeout(800);

    // 5. Remplir mot de passe
    const passSelectors = ['input[name="password"]', 'input[type="password"]', '#fm-login-password'];
    for (const sel of passSelectors) {
      try {
        const el = await loginFrame.$(sel);
        if (el) {
          await loginFrame.fill(sel, ALIEXPRESS_PASSWORD);
          console.log('[place-order] Password rempli avec:', sel);
          break;
        }
      } catch {}
    }
    await page.waitForTimeout(800);

    // 6. Cliquer connexion
    const submitSelectors = [
      'button[type="submit"]',
      '.login-submit',
      '#fm-login-submit',
      'button:has-text("Sign in")',
      'button:has-text("Log in")',
    ];
    for (const sel of submitSelectors) {
      try {
        const el = await loginFrame.$(sel);
        if (el) {
          await loginFrame.click(sel);
          console.log('[place-order] Submit cliqué avec:', sel);
          break;
        }
      } catch {}
    }

    await page.waitForTimeout(6000);
    console.log('[place-order] URL après login:', page.url());

    // 7. Aller sur la page produit
    console.log('[place-order] Navigation vers le produit...');
    await page.goto(aliexpress_url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(4000);

    // 8. Sélectionner la quantité si > 1
    if (quantity && quantity > 1) {
      try {
        const qtyInput = await page.$('input[class*="quantity"], input[data-role="quantity"]');
        if (qtyInput) {
          await qtyInput.click({ clickCount: 3 });
          await qtyInput.type(String(quantity));
        }
      } catch (e) {
        console.log('[place-order] Quantité non modifiée:', e.message);
      }
    }

    // 9. Cliquer sur "Buy Now"
    await page.waitForTimeout(2000);
    const buyNowSelectors = [
      'button:has-text("Buy Now")',
      'button:has-text("Acheter")',
      '[data-pl="buy-now"]',
      '.buy-now-btn',
      'a:has-text("Buy Now")'
    ];

    let clicked = false;
    for (const sel of buyNowSelectors) {
      try {
        const btn = await page.$(sel);
        if (btn) {
          await btn.click();
          clicked = true;
          console.log('[place-order] Buy Now cliqué:', sel);
          break;
        }
      } catch {}
    }

    if (!clicked) throw new Error('Bouton Buy Now introuvable');

    await page.waitForTimeout(5000);
    console.log('[place-order] URL après Buy Now:', page.url());

    // 10. Vérifier si on est sur checkout
    const currentUrl = page.url();
    if (!currentUrl.includes('trade') && !currentUrl.includes('order') && !currentUrl.includes('checkout')) {
      throw new Error(`Redirection inattendue: ${currentUrl}`);
    }

    // 11. Confirmer la commande
    await page.waitForTimeout(2000);
    const confirmSelectors = [
      'button:has-text("Place Order")',
      'button:has-text("Confirm Order")',
      'button:has-text("Passer la commande")',
      '[class*="place-order"]',
      '[class*="confirm-order"]',
    ];

    let confirmed = false;
    for (const sel of confirmSelectors) {
      try {
        const btn = await page.$(sel);
        if (btn) {
          await btn.click();
          confirmed = true;
          console.log('[place-order] Commande confirmée avec:', sel);
          break;
        }
      } catch {}
    }

    await page.waitForTimeout(5000);
    const finalUrl = page.url();
    console.log('[place-order] URL finale:', finalUrl);

    // 12. Extraire l'ID de commande
    let aliexpress_order_id = null;
    const orderIdMatch = finalUrl.match(/orderId=(\d+)/) || finalUrl.match(/order\/(\d+)/);
    if (orderIdMatch) aliexpress_order_id = orderIdMatch[1];

    if (!aliexpress_order_id) {
      try {
        const pageContent = await page.content();
        const contentMatch = pageContent.match(/"orderId":"?(\d+)"?/);
        if (contentMatch) aliexpress_order_id = contentMatch[1];
      } catch {}
    }

    await browser.close();

    return res.json({
      success: true,
      aliexpress_order_id: aliexpress_order_id || `manual_${order_id}`,
      message: confirmed ? 'Commande passée avec succès' : 'Commande initiée (vérification manuelle requise)',
      final_url: finalUrl
    });

  } catch (error) {
    if (browser) await browser.close();
    console.error('[place-order] ERREUR:', error.message);
    return res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur démarré sur le port ${PORT}`));
