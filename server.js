import express from 'express';
import { chromium } from 'playwright';

const app = express();
app.use(express.json());

const API_SECRET = process.env.RAILWAY_API_SECRET;

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

// Helper: trouver le frame avec des inputs
async function getLoginFrame(page) {
  const frames = page.frames();
  for (const f of frames) {
    try {
      const inputs = await f.$$('input');
      if (inputs.length > 0) return f;
    } catch {}
  }
  return null;
}

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

    // 1. Page de login
    console.log('[place-order] Navigation vers login...');
    await page.goto('https://login.aliexpress.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(5000);
    console.log('[place-order] URL:', page.url());

    // 2. Trouver le frame avec inputs
    let loginFrame = await getLoginFrame(page);
    if (!loginFrame) throw new Error('Aucun frame avec inputs trouvé');

    // Logger les inputs disponibles
    const inputsBefore = await loginFrame.$$eval('input', els => els.map(e => ({ type: e.type, name: e.name, id: e.id, placeholder: e.placeholder })));
    console.log('[place-order] Inputs initiaux:', JSON.stringify(inputsBefore));

    // 3. Remplir l'email (toujours le 1er input)
    const inputs = await loginFrame.$$('input');
    await inputs[0].click();
    await inputs[0].fill(ALIEXPRESS_MAIL);
    console.log('[place-order] Email rempli');
    await page.waitForTimeout(500);

    // 4. Appuyer sur Tab ou Enter pour déclencher l'étape suivante
    await inputs[0].press('Tab');
    await page.waitForTimeout(2000);

    // Vérifier si un nouveau champ password est apparu
    let allInputsAfter = await loginFrame.$$('input');
    console.log('[place-order] Inputs après Tab:', allInputsAfter.length);

    // Si toujours 1 seul input, essayer Enter
    if (allInputsAfter.length < 2) {
      await inputs[0].press('Enter');
      await page.waitForTimeout(3000);
      allInputsAfter = await loginFrame.$$('input');
      console.log('[place-order] Inputs après Enter:', allInputsAfter.length);
    }

    // Si toujours pas de password, chercher un bouton "Continue" / "Next"
    if (allInputsAfter.length < 2) {
      const continueSelectors = [
        'button:has-text("Continue")',
        'button:has-text("Next")',
        'button:has-text("Continuer")',
        'button[type="submit"]',
      ];
      for (const sel of continueSelectors) {
        try {
          const btn = await loginFrame.$(sel);
          if (btn) {
            await btn.click();
            console.log('[place-order] Continue cliqué:', sel);
            await page.waitForTimeout(3000);
            break;
          }
        } catch {}
      }
      allInputsAfter = await loginFrame.$$('input');
      console.log('[place-order] Inputs après Continue:', allInputsAfter.length);
    }

    // 5. Remplir le password
    if (allInputsAfter.length >= 2) {
      // Trouver le champ password (type=password ou le 2ème input)
      let passwordInput = null;
      for (const inp of allInputsAfter) {
        const type = await inp.getAttribute('type');
        if (type === 'password') { passwordInput = inp; break; }
      }
      if (!passwordInput) passwordInput = allInputsAfter[allInputsAfter.length - 1];

      await passwordInput.click();
      await passwordInput.fill(ALIEXPRESS_PASSWORD);
      console.log('[place-order] Password rempli');
      await page.waitForTimeout(500);
      await passwordInput.press('Enter');
    } else {
      // Dernier recours : remplir le seul input visible avec le password et Enter
      console.log('[place-order] Toujours 1 input — tentative direct password sur input[0]');
      await allInputsAfter[0].fill(ALIEXPRESS_PASSWORD);
      await allInputsAfter[0].press('Enter');
    }

    await page.waitForTimeout(6000);
    console.log('[place-order] URL après login:', page.url());

    // 6. Aller sur la page produit
    console.log('[place-order] Navigation vers le produit...');
    await page.goto(aliexpress_url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(4000);

    // 7. Quantité
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

    // 8. Buy Now
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

    const checkoutUrl = page.url();
    if (!checkoutUrl.includes('trade') && !checkoutUrl.includes('order') && !checkoutUrl.includes('checkout')) {
      throw new Error(`Redirection inattendue: ${checkoutUrl}`);
    }

    // 9. Confirmer commande
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

    // 10. Extraire order ID
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
