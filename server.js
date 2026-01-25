/**
 * SearXNG Proxy Server
 * Version: 1.2.1
 * Last Update: 2026-01-25
 *
 * Cambios v1.2.1:
 * - Mejorada descarga de PDFs: sigue redirecciones y extrae URL real de páginas intermedias
 * - Verifica Content-Type y header PDF válido
 * - Extrae nombre de archivo de Content-Disposition
 *
 * Cambios v1.2.0:
 * - Mejorada detección de PDFs: ahora detecta enlaces dinámicos (sdm_process_download, etc.)
 * - Detecta PDFs por texto del enlace (descargar, boletín, informe)
 *
 * Cambios v1.1.1:
 * - /info ahora requiere token (INFO_TOKEN) para acceso
 *
 * Cambios v1.1.0:
 * - Puppeteer ahora es opcional (carga dinámica)
 * - Agregado endpoint /info para debugging
 * - Mejor manejo de errores y SIGTERM
 * - Integración con Open WebUI RAG
 */

const express = require('express');
const cors = require('cors');
const cheerio = require('cheerio');
const FormData = require('form-data');

const VERSION = '1.2.1';
const BUILD_DATE = '2026-01-25T19:00:00Z';

// Puppeteer es opcional - cargarlo dinámicamente solo cuando se necesite
let puppeteer = null;
async function getPuppeteer() {
  if (!puppeteer) {
    try {
      puppeteer = require('puppeteer');
      console.log('[Puppeteer] Loaded successfully');
    } catch (error) {
      console.warn('[Puppeteer] Not available:', error.message);
      return null;
    }
  }
  return puppeteer;
}

const app = express();
const PORT = process.env.PORT || 3000;

// URL de SearXNG (puede configurarse via variable de entorno)
const SEARXNG_URL = process.env.SEARXNG_URL || 'https://automatizacion-searxng.0hidyn.easypanel.host';

// Open WebUI Configuration
const OPENWEBUI_URL = process.env.OPENWEBUI_URL || 'https://sigai.planautomotor.com.ec';
const OPENWEBUI_API_KEY = process.env.OPENWEBUI_API_KEY || ''; // Clave API de Open WebUI
const OPENWEBUI_KNOWLEDGE_ID = process.env.OPENWEBUI_KNOWLEDGE_ID || ''; // ID de la Knowledge Base "EvoX_DocProxy"

// Habilitar CORS para todas las peticiones
app.use(cors());
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Info endpoint for debugging - PROTEGIDO CON TOKEN
// Usar: /info?token=TU_TOKEN o configurar INFO_TOKEN en variables de entorno
const INFO_TOKEN = process.env.INFO_TOKEN || '';

app.get('/info', async (req, res) => {
  // Si hay token configurado, requerir autenticación
  if (INFO_TOKEN && req.query.token !== INFO_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized', hint: 'Add ?token=YOUR_TOKEN' });
  }

  const pup = await getPuppeteer();
  res.json({
    status: 'ok',
    version: VERSION,
    buildDate: BUILD_DATE,
    timestamp: new Date().toISOString(),
    config: {
      searxngUrl: SEARXNG_URL,
      openwebuiUrl: OPENWEBUI_URL,
      apiKeyConfigured: !!OPENWEBUI_API_KEY,
      knowledgeIdConfigured: !!OPENWEBUI_KNOWLEDGE_ID
    },
    capabilities: {
      search: true,
      fetch: true,
      fetchJs: !!pup,
      rag: !!OPENWEBUI_API_KEY
    },
    memory: {
      heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
      heapTotal: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + 'MB',
      rss: Math.round(process.memoryUsage().rss / 1024 / 1024) + 'MB'
    },
    uptime: Math.round(process.uptime()) + ' seconds'
  });
});

// Proxy de búsqueda
app.get('/search', async (req, res) => {
  try {
    const queryString = new URLSearchParams(req.query).toString();
    const url = `${SEARXNG_URL}/search?${queryString}`;

    console.log(`[Proxy] Buscando: ${req.query.q}`);

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'SearXNG-Proxy/1.0'
      }
    });

    if (!response.ok) {
      throw new Error(`SearXNG returned ${response.status}`);
    }

    const data = await response.json();
    console.log(`[Proxy] ${data.results?.length || 0} resultados`);

    res.json(data);
  } catch (error) {
    console.error('[Proxy] Error:', error.message);
    res.status(500).json({
      error: 'Error en búsqueda',
      message: error.message
    });
  }
});

// Proxy genérico para otros endpoints de SearXNG
app.get('/config', async (req, res) => {
  try {
    const response = await fetch(`${SEARXNG_URL}/config`);
    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch y parseo de contenido web
app.get('/fetch', async (req, res) => {
  try {
    const { url } = req.query;

    if (!url) {
      return res.status(400).json({ error: 'URL parameter required' });
    }

    console.log(`[Fetch] Obteniendo: ${url}`);

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8'
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const contentType = response.headers.get('content-type') || '';

    // Si es JSON, devolverlo directamente
    if (contentType.includes('application/json')) {
      const data = await response.json();
      return res.json({ type: 'json', data, url });
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    // Remover scripts, styles y elementos no deseados
    $('script, style, nav, footer, header, aside, iframe, noscript').remove();

    // Extraer título
    const title = $('title').text().trim() || $('h1').first().text().trim();

    // Extraer texto principal (párrafos, listas, headings)
    const textContent = [];
    $('p, li, h1, h2, h3, h4, h5, h6, td, th').each((i, el) => {
      const text = $(el).text().trim();
      if (text && text.length > 10) {
        textContent.push(text);
      }
    });

    // Extraer tablas
    const tables = [];
    $('table').each((tableIndex, table) => {
      const tableData = {
        headers: [],
        rows: []
      };

      // Headers
      $(table).find('thead tr th, thead tr td, tr:first-child th').each((i, th) => {
        tableData.headers.push($(th).text().trim());
      });

      // Si no hay thead, usar primera fila como headers
      if (tableData.headers.length === 0) {
        $(table).find('tr:first-child td').each((i, td) => {
          tableData.headers.push($(td).text().trim());
        });
      }

      // Rows
      $(table).find('tbody tr, tr').each((rowIndex, tr) => {
        // Skip header row if we already extracted it
        if (rowIndex === 0 && tableData.headers.length > 0) {
          const firstRowCells = $(tr).find('th, td');
          if (firstRowCells.length === tableData.headers.length) {
            let isHeader = true;
            firstRowCells.each((i, cell) => {
              if ($(cell).text().trim() !== tableData.headers[i]) {
                isHeader = false;
              }
            });
            if (isHeader) return;
          }
        }

        const row = [];
        $(tr).find('td, th').each((i, td) => {
          row.push($(td).text().trim());
        });
        if (row.length > 0 && row.some(cell => cell.length > 0)) {
          tableData.rows.push(row);
        }
      });

      if (tableData.rows.length > 0 || tableData.headers.length > 0) {
        tables.push(tableData);
      }
    });

    // Extraer enlaces relevantes (PDFs, Excel, etc)
    const downloadLinks = [];
    const seenUrls = new Set(); // Evitar duplicados

    $('a[href]').each((i, a) => {
      const href = $(a).attr('href');
      const text = $(a).text().trim().toLowerCase();
      const hrefLower = (href || '').toLowerCase();

      if (!href) return;

      let type = null;

      // Detección por extensión de archivo
      if (hrefLower.endsWith('.pdf')) type = 'pdf';
      else if (hrefLower.endsWith('.xlsx')) type = 'xlsx';
      else if (hrefLower.endsWith('.xls')) type = 'xls';
      else if (hrefLower.endsWith('.csv')) type = 'csv';
      // Detección por patrones de descarga en la URL
      else if (hrefLower.includes('download') && (text.includes('pdf') || hrefLower.includes('pdf'))) type = 'pdf';
      else if (hrefLower.includes('sdm_process_download')) type = 'pdf'; // WordPress Download Manager
      else if (hrefLower.includes('/descargar') || hrefLower.includes('/download')) {
        // Inferir tipo del texto del enlace
        if (text.includes('pdf')) type = 'pdf';
        else if (text.includes('excel') || text.includes('xlsx')) type = 'xlsx';
        else type = 'pdf'; // Default a PDF para enlaces de descarga
      }
      // Detección por texto del enlace que indica descarga
      else if ((text.includes('descargar') || text.includes('download')) &&
               (text.includes('pdf') || text.includes('boletín') || text.includes('informe') || text.includes('reporte'))) {
        type = 'pdf';
      }

      if (type) {
        const fullUrl = href.startsWith('http') ? href : new URL(href, url).href;
        if (!seenUrls.has(fullUrl)) {
          seenUrls.add(fullUrl);
          downloadLinks.push({
            text: $(a).text().trim() || href,
            url: fullUrl,
            type
          });
        }
      }
    });

    console.log(`[Fetch] Extraído: ${textContent.length} textos, ${tables.length} tablas, ${downloadLinks.length} archivos`);

    res.json({
      type: 'html',
      url,
      title,
      textContent: textContent.slice(0, 50), // Limitar a 50 párrafos
      tables: tables.slice(0, 10), // Limitar a 10 tablas
      downloadLinks: downloadLinks.slice(0, 20), // Limitar a 20 enlaces
      fetchedAt: new Date().toISOString()
    });

  } catch (error) {
    console.error('[Fetch] Error:', error.message);
    res.status(500).json({
      error: 'Error fetching URL',
      message: error.message
    });
  }
});

// Fetch con Puppeteer para sitios JavaScript-heavy
app.get('/fetch-js', async (req, res) => {
  let browser = null;

  try {
    const { url } = req.query;

    if (!url) {
      return res.status(400).json({ error: 'URL parameter required' });
    }

    // Cargar Puppeteer dinámicamente
    const pup = await getPuppeteer();
    if (!pup) {
      return res.status(503).json({
        error: 'Puppeteer not available',
        message: 'JavaScript rendering is not available on this server. Use /fetch instead.',
        suggestion: 'Try using the static fetch endpoint: /fetch'
      });
    }

    console.log(`[FetchJS] Obteniendo con Puppeteer: ${url}`);

    // Iniciar browser con configuración para Docker
    const launchOptions = {
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--single-process',
        '--no-zygote',
        '--window-size=1920x1080'
      ]
    };

    // Usar Chromium del sistema si está configurado
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
      launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    }

    browser = await pup.launch(launchOptions);

    const page = await browser.newPage();

    // Configurar user agent
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // Configurar viewport
    await page.setViewport({ width: 1920, height: 1080 });

    // Navegar a la URL con timeout de 30 segundos
    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: 30000
    });

    // Esperar un poco más para que el JS se ejecute
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Obtener el HTML renderizado
    const html = await page.content();

    await browser.close();
    browser = null;

    // Parsear con cheerio
    const $ = cheerio.load(html);

    // Remover scripts, styles y elementos no deseados
    $('script, style, nav, footer, header, aside, iframe, noscript').remove();

    // Extraer título
    const title = $('title').text().trim() || $('h1').first().text().trim();

    // Extraer texto principal
    const textContent = [];
    $('p, li, h1, h2, h3, h4, h5, h6, td, th, span, div').each((i, el) => {
      const text = $(el).clone().children().remove().end().text().trim();
      if (text && text.length > 10 && !textContent.includes(text)) {
        textContent.push(text);
      }
    });

    // Extraer tablas
    const tables = [];
    $('table').each((tableIndex, table) => {
      const tableData = {
        headers: [],
        rows: []
      };

      $(table).find('thead tr th, thead tr td, tr:first-child th').each((i, th) => {
        tableData.headers.push($(th).text().trim());
      });

      if (tableData.headers.length === 0) {
        $(table).find('tr:first-child td').each((i, td) => {
          tableData.headers.push($(td).text().trim());
        });
      }

      $(table).find('tbody tr, tr').each((rowIndex, tr) => {
        if (rowIndex === 0 && tableData.headers.length > 0) {
          const firstRowCells = $(tr).find('th, td');
          if (firstRowCells.length === tableData.headers.length) {
            let isHeader = true;
            firstRowCells.each((i, cell) => {
              if ($(cell).text().trim() !== tableData.headers[i]) {
                isHeader = false;
              }
            });
            if (isHeader) return;
          }
        }

        const row = [];
        $(tr).find('td, th').each((i, td) => {
          row.push($(td).text().trim());
        });
        if (row.length > 0 && row.some(cell => cell.length > 0)) {
          tableData.rows.push(row);
        }
      });

      if (tableData.rows.length > 0 || tableData.headers.length > 0) {
        tables.push(tableData);
      }
    });

    // Extraer enlaces de descarga (mejorado para detectar enlaces dinámicos)
    const downloadLinks = [];
    const seenUrls = new Set();

    $('a[href]').each((i, a) => {
      const href = $(a).attr('href');
      const text = $(a).text().trim().toLowerCase();
      const hrefLower = (href || '').toLowerCase();

      if (!href) return;

      let type = null;

      // Detección por extensión
      if (hrefLower.endsWith('.pdf')) type = 'pdf';
      else if (hrefLower.endsWith('.xlsx')) type = 'xlsx';
      else if (hrefLower.endsWith('.xls')) type = 'xls';
      else if (hrefLower.endsWith('.csv')) type = 'csv';
      // Detección por patrones de descarga
      else if (hrefLower.includes('download') && (text.includes('pdf') || hrefLower.includes('pdf'))) type = 'pdf';
      else if (hrefLower.includes('sdm_process_download')) type = 'pdf';
      else if (hrefLower.includes('/descargar') || hrefLower.includes('/download')) {
        if (text.includes('pdf')) type = 'pdf';
        else if (text.includes('excel') || text.includes('xlsx')) type = 'xlsx';
        else type = 'pdf';
      }
      else if ((text.includes('descargar') || text.includes('download')) &&
               (text.includes('pdf') || text.includes('boletín') || text.includes('informe') || text.includes('reporte'))) {
        type = 'pdf';
      }

      if (type) {
        const fullUrl = href.startsWith('http') ? href : new URL(href, url).href;
        if (!seenUrls.has(fullUrl)) {
          seenUrls.add(fullUrl);
          downloadLinks.push({
            text: $(a).text().trim() || href,
            url: fullUrl,
            type
          });
        }
      }
    });

    console.log(`[FetchJS] Extraído: ${textContent.length} textos, ${tables.length} tablas, ${downloadLinks.length} archivos`);

    res.json({
      type: 'html',
      url,
      title,
      textContent: textContent.slice(0, 50),
      tables: tables.slice(0, 10),
      downloadLinks: downloadLinks.slice(0, 20),
      fetchedAt: new Date().toISOString(),
      renderedWith: 'puppeteer'
    });

  } catch (error) {
    console.error('[FetchJS] Error:', error.message);
    if (browser) {
      await browser.close();
    }
    res.status(500).json({
      error: 'Error fetching URL with Puppeteer',
      message: error.message
    });
  }
});

// ===== Open WebUI RAG Integration =====

/**
 * Helper: Obtiene el API Key (de variable de entorno o del request)
 */
function getApiKey(reqApiKey) {
  return OPENWEBUI_API_KEY || reqApiKey;
}

/**
 * Helper: Espera a que el archivo esté procesado
 */
async function waitForFileProcessing(fileId, apiKey, maxAttempts = 30) {
  for (let i = 0; i < maxAttempts; i++) {
    const statusResponse = await fetch(`${OPENWEBUI_URL}/api/v1/files/${fileId}`, {
      headers: { 'Authorization': `Bearer ${apiKey}` }
    });

    if (statusResponse.ok) {
      const fileData = await statusResponse.json();
      // Verificar si el archivo tiene contenido procesado
      if (fileData.data && fileData.data.content) {
        console.log(`[RAG] Archivo procesado correctamente`);
        return true;
      }
    }

    console.log(`[RAG] Esperando procesamiento... (${i + 1}/${maxAttempts})`);
    await new Promise(resolve => setTimeout(resolve, 2000)); // Esperar 2 segundos
  }

  return false;
}

/**
 * Descarga un PDF y lo sube a Open WebUI Knowledge Base
 * POST /upload-to-rag
 * Body: { pdfUrl: string, filename?: string, knowledgeId?: string }
 *
 * Usa variables de entorno:
 * - OPENWEBUI_API_KEY: API Key de Open WebUI
 * - OPENWEBUI_KNOWLEDGE_ID: ID de la Knowledge Base
 */
app.post('/upload-to-rag', async (req, res) => {
  try {
    const { pdfUrl, filename, knowledgeId } = req.body;
    const apiKey = getApiKey(req.body.apiKey);
    const kbId = knowledgeId || OPENWEBUI_KNOWLEDGE_ID;

    if (!pdfUrl) {
      return res.status(400).json({ error: 'pdfUrl is required' });
    }

    if (!apiKey) {
      return res.status(400).json({
        error: 'API Key not configured',
        hint: 'Set OPENWEBUI_API_KEY environment variable or pass apiKey in request body'
      });
    }

    console.log(`[RAG] Descargando PDF: ${pdfUrl}`);

    // 1. Descargar el PDF (siguiendo redirecciones)
    let pdfResponse = await fetch(pdfUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/pdf,*/*'
      },
      redirect: 'follow'
    });

    if (!pdfResponse.ok) {
      throw new Error(`Error descargando PDF: ${pdfResponse.status}`);
    }

    // Verificar el Content-Type
    const contentType = pdfResponse.headers.get('content-type') || '';
    console.log(`[RAG] Content-Type recibido: ${contentType}`);

    // Si es HTML, puede ser una página de descarga - intentar extraer el link real
    if (contentType.includes('text/html')) {
      const htmlContent = await pdfResponse.text();

      // Buscar meta refresh o link directo al PDF
      const metaRefreshMatch = htmlContent.match(/url=([^"'\s>]+\.pdf[^"'\s>]*)/i);
      const directLinkMatch = htmlContent.match(/href=["']([^"']+\.pdf[^"']*)["']/i);

      let realPdfUrl = null;
      if (metaRefreshMatch) {
        realPdfUrl = metaRefreshMatch[1];
      } else if (directLinkMatch) {
        realPdfUrl = directLinkMatch[1];
      }

      if (realPdfUrl) {
        // Construir URL completa si es relativa
        if (!realPdfUrl.startsWith('http')) {
          const baseUrl = new URL(pdfUrl);
          realPdfUrl = new URL(realPdfUrl, baseUrl.origin).href;
        }

        console.log(`[RAG] Redirigiendo a PDF real: ${realPdfUrl}`);
        pdfResponse = await fetch(realPdfUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'application/pdf,*/*'
          },
          redirect: 'follow'
        });

        if (!pdfResponse.ok) {
          throw new Error(`Error descargando PDF real: ${pdfResponse.status}`);
        }
      } else {
        throw new Error('El enlace no apunta a un PDF válido. Recibido: HTML sin link a PDF');
      }
    }

    const pdfBuffer = Buffer.from(await pdfResponse.arrayBuffer());

    // Verificar que sea un PDF válido (los PDFs empiezan con %PDF)
    const pdfHeader = pdfBuffer.slice(0, 5).toString();
    if (!pdfHeader.startsWith('%PDF')) {
      console.warn(`[RAG] Advertencia: El archivo no parece ser un PDF válido. Header: ${pdfHeader}`);
    }

    // Obtener nombre del archivo
    let pdfFilename = filename;
    if (!pdfFilename) {
      // Intentar obtener de Content-Disposition
      const contentDisposition = pdfResponse.headers.get('content-disposition');
      if (contentDisposition) {
        const filenameMatch = contentDisposition.match(/filename[*]?=["']?(?:UTF-8'')?([^"';\n]+)/i);
        if (filenameMatch) {
          pdfFilename = decodeURIComponent(filenameMatch[1]);
        }
      }
    }
    if (!pdfFilename) {
      pdfFilename = decodeURIComponent(pdfUrl.split('/').pop().split('?')[0]) || 'document.pdf';
    }
    // Asegurar extensión .pdf
    if (!pdfFilename.toLowerCase().endsWith('.pdf')) {
      pdfFilename += '.pdf';
    }

    console.log(`[RAG] PDF descargado: ${pdfFilename} (${pdfBuffer.length} bytes)`);

    // 2. Crear FormData para subir a Open WebUI
    const formData = new FormData();
    formData.append('file', pdfBuffer, {
      filename: pdfFilename,
      contentType: 'application/pdf'
    });

    // 3. Subir a Open WebUI Files API
    console.log(`[RAG] Subiendo a Open WebUI: ${OPENWEBUI_URL}`);

    const uploadResponse = await fetch(`${OPENWEBUI_URL}/api/v1/files/`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        ...formData.getHeaders()
      },
      body: formData
    });

    if (!uploadResponse.ok) {
      const errorText = await uploadResponse.text();
      throw new Error(`Error subiendo a Open WebUI: ${uploadResponse.status} - ${errorText}`);
    }

    const uploadResult = await uploadResponse.json();
    console.log(`[RAG] Archivo subido con ID:`, uploadResult.id);

    // 4. Esperar a que el archivo sea procesado
    console.log(`[RAG] Esperando procesamiento del archivo...`);
    const isProcessed = await waitForFileProcessing(uploadResult.id, apiKey);

    if (!isProcessed) {
      console.warn(`[RAG] El archivo puede no estar completamente procesado`);
    }

    // 5. Agregar a Knowledge Base si se especificó
    let knowledgeResult = null;
    if (kbId) {
      console.log(`[RAG] Agregando a Knowledge Base: ${kbId}`);

      const addToKbResponse = await fetch(`${OPENWEBUI_URL}/api/v1/knowledge/${kbId}/file/add`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ file_id: uploadResult.id })
      });

      if (addToKbResponse.ok) {
        knowledgeResult = await addToKbResponse.json();
        console.log(`[RAG] Archivo agregado a Knowledge Base`);
      } else {
        const kbError = await addToKbResponse.text();
        console.warn(`[RAG] No se pudo agregar a KB: ${kbError}`);
      }
    }

    res.json({
      success: true,
      message: kbId ? 'PDF subido a Knowledge Base' : 'PDF subido a Open WebUI',
      file: uploadResult,
      knowledgeBase: knowledgeResult,
      originalUrl: pdfUrl
    });

  } catch (error) {
    console.error('[RAG] Error:', error.message);
    res.status(500).json({
      error: 'Error subiendo PDF a RAG',
      message: error.message
    });
  }
});

/**
 * Consulta el RAG de Open WebUI usando Knowledge Base
 * POST /query-rag
 * Body: { query: string, model?: string, knowledgeId?: string }
 */
app.post('/query-rag', async (req, res) => {
  try {
    const { query, model, knowledgeId } = req.body;
    const apiKey = getApiKey(req.body.apiKey);
    const kbId = knowledgeId || OPENWEBUI_KNOWLEDGE_ID;

    if (!query) {
      return res.status(400).json({ error: 'query is required' });
    }

    if (!apiKey) {
      return res.status(400).json({ error: 'API Key not configured' });
    }

    console.log(`[RAG] Consultando: ${query}`);

    // Construir request body
    const requestBody = {
      model: model || 'llama3.2:latest',
      messages: [
        {
          role: 'user',
          content: query
        }
      ],
      stream: false
    };

    // Si hay Knowledge Base, usar como collection
    if (kbId) {
      requestBody.files = [
        {
          type: 'collection',
          id: kbId
        }
      ];
    }

    const response = await fetch(`${OPENWEBUI_URL}/api/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Error en consulta RAG: ${response.status} - ${errorText}`);
    }

    const result = await response.json();
    console.log(`[RAG] Respuesta recibida`);

    res.json({
      success: true,
      response: result.choices?.[0]?.message?.content || result.message?.content || result,
      usage: result.usage,
      knowledgeBaseUsed: kbId || null
    });

  } catch (error) {
    console.error('[RAG] Query error:', error.message);
    res.status(500).json({
      error: 'Error consultando RAG',
      message: error.message
    });
  }
});

/**
 * Lista Knowledge Bases disponibles
 * GET /list-knowledge-bases
 */
app.get('/list-knowledge-bases', async (req, res) => {
  try {
    const apiKey = getApiKey(req.query.apiKey);

    if (!apiKey) {
      return res.status(400).json({ error: 'API Key not configured' });
    }

    const response = await fetch(`${OPENWEBUI_URL}/api/v1/knowledge/`, {
      headers: {
        'Authorization': `Bearer ${apiKey}`
      }
    });

    if (!response.ok) {
      throw new Error(`Error listando knowledge bases: ${response.status}`);
    }

    const knowledgeBases = await response.json();
    console.log(`[RAG] ${knowledgeBases.length || 0} knowledge bases encontradas`);

    res.json({
      success: true,
      knowledgeBases,
      configuredKnowledgeId: OPENWEBUI_KNOWLEDGE_ID || null,
      openwebuiUrl: OPENWEBUI_URL
    });

  } catch (error) {
    console.error('[RAG] List KB error:', error.message);
    res.status(500).json({
      error: 'Error listando knowledge bases',
      message: error.message
    });
  }
});

/**
 * Lista archivos en Open WebUI
 * GET /list-rag-files
 */
app.get('/list-rag-files', async (req, res) => {
  try {
    const apiKey = getApiKey(req.query.apiKey);

    if (!apiKey) {
      return res.status(400).json({ error: 'API Key not configured' });
    }

    const response = await fetch(`${OPENWEBUI_URL}/api/v1/files/`, {
      headers: {
        'Authorization': `Bearer ${apiKey}`
      }
    });

    if (!response.ok) {
      throw new Error(`Error listando archivos: ${response.status}`);
    }

    const files = await response.json();
    console.log(`[RAG] ${files.length || 0} archivos encontrados`);

    res.json({
      success: true,
      files,
      openwebuiUrl: OPENWEBUI_URL
    });

  } catch (error) {
    console.error('[RAG] List error:', error.message);
    res.status(500).json({
      error: 'Error listando archivos',
      message: error.message
    });
  }
});

/**
 * Verifica la configuración de RAG
 * GET /rag-config
 */
app.get('/rag-config', (req, res) => {
  res.json({
    openwebuiUrl: OPENWEBUI_URL,
    apiKeyConfigured: !!OPENWEBUI_API_KEY,
    knowledgeIdConfigured: !!OPENWEBUI_KNOWLEDGE_ID,
    knowledgeId: OPENWEBUI_KNOWLEDGE_ID || null
  });
});

// Global error handlers
process.on('uncaughtException', (error) => {
  console.error('[FATAL] Uncaught Exception:', error.message);
  console.error(error.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('SIGTERM', () => {
  console.log('[SHUTDOWN] Received SIGTERM, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[SHUTDOWN] Received SIGINT, shutting down gracefully...');
  process.exit(0);
});

// Start server
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log('========================================');
  console.log(`SearXNG Proxy v${VERSION} (${BUILD_DATE})`);
  console.log(`Running on port ${PORT}`);
  console.log(`Proxying to: ${SEARXNG_URL}`);
  console.log(`Open WebUI RAG: ${OPENWEBUI_URL}`);
  console.log(`API Key configured: ${OPENWEBUI_API_KEY ? 'Yes' : 'No'}`);
  console.log(`Knowledge Base ID: ${OPENWEBUI_KNOWLEDGE_ID || 'Not configured'}`);
  console.log(`Memory: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB used`);
  console.log('========================================');
});

// Handle server errors
server.on('error', (error) => {
  console.error('[SERVER ERROR]:', error.message);
});
