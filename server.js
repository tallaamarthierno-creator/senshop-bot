import express from 'express';

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

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Cache-Control': 'max-age=0',
        'TE': 'trailers',
      }
    });

    const html = await response.text();

    // Extraire window.runParams du HTML brut
    const match = html.match(/window\.runParams\s*=\s*(\{[\s\S]+?\});\s*(?:window|var|let|const|<\/script>)/);
    if (match) {
      const json = JSON.parse(match[1]);
      const d = json?.data;
      const title = d?.titleModule?.subject;
      const price = d?.priceModule?.minAmount?.value || d?.priceModule?.minPrice?.value;
      const images = d?.imageModule?.imagePathList;

      if (title) {
        return res.json({
          name: title,
          price_usd: price ? parseFloat(String(price).replace(/[^\d.]/g, '')) || null : null,
          image_url: images?.[0] ? `https:${images[0]}` : null
        });
      }
    }

    // Fallback: meta tags dans le HTML brut
    const ogTitle = html.match(/<meta property="og:title" content="([^"]+)"/)?.[1];
    const ogImage = html.match(/<meta property="og:image" content="([^"]+)"/)?.[1];

    res.json({
      name: ogTitle || null,
      price_usd: null,
      image_url: ogImage || null
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur démarré sur le port ${PORT}`));
