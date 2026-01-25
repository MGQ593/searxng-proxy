/**
 * SearXNG Proxy Server
 * Version: 1.3.0
 * Last Update: 2026-01-26
 *
 * Cambios v1.3.0:
 * - Nuevo endpoint /upload-file para múltiples formatos (PDF, DOCX, XLSX, CSV, TXT)
 * - Soporte para mammoth (DOCX) y xlsx (Excel) libraries
 * - Extracción de texto de documentos para contexto AI
 *
 * Cambios v1.2.7:
 * - Fallback a todos los archivos de Open WebUI si la KB está vacía
 * - Mejor manejo de archivos subidos que no se asociaron a la KB
 *
 * Cambios v1.2.6:
 * - Nuevo endpoint /debug-rag para diagnosticar contenido de Knowledge Base
 * - Mejorado /retrieve-only con múltiples estrategias de retrieval
 * - Soporte para diferentes formatos de collection_names en Open WebUI
 *
 * Cambios v1.2.5:
 * - Nuevo endpoint /retrieve-only para obtener fragmentos sin generación
 * - Permite usar RAG sin necesidad de modelo configurado en Open WebUI
 * - Los fragmentos se pasan al modelo principal (Azure OpenAI) del add-in
 *
 * Cambios v1.2.4:
 * - Modelo RAG configurable via OPENWEBUI_MODEL
 * - Si no se especifica modelo, Open WebUI usa el default del servidor
 *
 * Cambios v1.2.3:
 * - Corregido upload a Open WebUI: usar http/https nativo con form-data.pipe()
 * - fetch nativo de Node.js no maneja bien FormData multipart
 *
 * Cambios v1.2.2:
 * - Intento fallido con stream + knownLength (fetch no lo soporta bien)
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

const VERSION = '1.3.0';
const BUILD_DATE = '2026-01-26T02:00:00Z';

// Document processing libraries (optional, load dynamically)
let mammoth = null;
let XLSX = null;

async function getMammoth() {
  if (!mammoth) {
    try {
      mammoth = require('mammoth');
      console.log('[Mammoth] Loaded successfully');
    } catch (error) {
      console.warn('[Mammoth] Not available:', error.message);
      return null;
    }
  }
  return mammoth;
}

async function getXLSX() {
  if (!XLSX) {
    try {
      XLSX = require('xlsx');
      console.log('[XLSX] Loaded successfully');
    } catch (error) {
      console.warn('[XLSX] Not available:', error.message);
      return null;
    }
  }
  return XLSX;
}

// Puppeteer es opcional - cargarlo dinámicamente solo cuando se necesite
// Usamos puppeteer-core para evitar descarga automática de Chrome
let puppeteer = null;
async function getPuppeteer() {
  if (!puppeteer) {
    try {
      puppeteer = require('puppeteer-core');
      console.log('[Puppeteer] puppeteer-core loaded successfully');
    } catch (error) {
      console.warn('[Puppeteer] Not available:', error.message);
      return null;
    }
  }
  return puppeteer;
}

// Helper para encontrar Chrome en el sistema
function findChromePath() {
  const possiblePaths = [
    // Windows
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
    // Linux
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    // macOS
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    // Environment variable override
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_PATH
  ];

  const fs = require('fs');
  for (const p of possiblePaths) {
    if (p && fs.existsSync(p)) {
      return p;
    }
  }
  return null;
}

const app = express();
const PORT = process.env.PORT || 3000;

// URL de SearXNG (puede configurarse via variable de entorno)
const SEARXNG_URL = process.env.SEARXNG_URL || 'https://automatizacion-searxng.0hidyn.easypanel.host';

// Open WebUI Configuration
const OPENWEBUI_URL = process.env.OPENWEBUI_URL || 'https://sigai.planautomotor.com.ec';
const OPENWEBUI_API_KEY = process.env.OPENWEBUI_API_KEY || ''; // Clave API de Open WebUI
const OPENWEBUI_KNOWLEDGE_ID = process.env.OPENWEBUI_KNOWLEDGE_ID || ''; // ID de la Knowledge Base "EvoX_DocProxy"
const OPENWEBUI_MODEL = process.env.OPENWEBUI_MODEL || ''; // Modelo a usar (vacío = usar modelo por defecto del servidor)

// Habilitar CORS para todas las peticiones
app.use(cors());
// Aumentar límite de JSON para soportar archivos base64 (50MB)
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

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

    // Buscar Chrome en el sistema
    const chromePath = findChromePath();
    if (!chromePath) {
      return res.status(503).json({
        error: 'Chrome not found',
        message: 'No se encontró Chrome/Chromium instalado en el sistema. Use /fetch para contenido estático.',
        suggestion: 'Instale Google Chrome o configure CHROME_PATH variable de entorno'
      });
    }

    console.log(`[FetchJS] Usando Chrome: ${chromePath}`);

    // Iniciar browser con configuración para Docker/Windows
    const launchOptions = {
      executablePath: chromePath,
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
 * Helper: Extrae texto de diferentes tipos de archivo
 */
async function extractTextFromFile(buffer, filename, mimeType) {
  const ext = filename.toLowerCase().split('.').pop();

  // PDF - usar pdf-parse si está disponible, o devolver indicación
  if (ext === 'pdf' || mimeType === 'application/pdf') {
    try {
      const pdfParse = require('pdf-parse');
      const data = await pdfParse(buffer);
      return {
        success: true,
        text: data.text,
        pages: data.numpages,
        type: 'pdf'
      };
    } catch (error) {
      // Si pdf-parse no está disponible, devolver buffer para subir a Open WebUI
      console.log('[Extract] pdf-parse no disponible, se subirá directamente a Open WebUI');
      return {
        success: true,
        text: null,
        uploadToOpenWebUI: true,
        type: 'pdf'
      };
    }
  }

  // DOCX - usar mammoth
  if (ext === 'docx' || mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    const mammothLib = await getMammoth();
    if (!mammothLib) {
      return { success: false, error: 'mammoth library not installed. Run: npm install mammoth' };
    }

    try {
      const result = await mammothLib.extractRawText({ buffer: buffer });
      return {
        success: true,
        text: result.value,
        messages: result.messages,
        type: 'docx'
      };
    } catch (error) {
      return { success: false, error: `Error procesando DOCX: ${error.message}` };
    }
  }

  // XLSX/XLS - usar xlsx
  if (ext === 'xlsx' || ext === 'xls' ||
      mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      mimeType === 'application/vnd.ms-excel') {
    const xlsxLib = await getXLSX();
    if (!xlsxLib) {
      return { success: false, error: 'xlsx library not installed. Run: npm install xlsx' };
    }

    try {
      const workbook = xlsxLib.read(buffer, { type: 'buffer' });
      const sheets = {};
      let allText = [];

      for (const sheetName of workbook.SheetNames) {
        const sheet = workbook.Sheets[sheetName];
        // Convertir a CSV para texto legible
        const csv = xlsxLib.utils.sheet_to_csv(sheet);
        sheets[sheetName] = csv;
        allText.push(`=== Hoja: ${sheetName} ===\n${csv}`);
      }

      return {
        success: true,
        text: allText.join('\n\n'),
        sheets: sheets,
        sheetNames: workbook.SheetNames,
        type: 'xlsx'
      };
    } catch (error) {
      return { success: false, error: `Error procesando Excel: ${error.message}` };
    }
  }

  // CSV - lectura directa
  if (ext === 'csv' || mimeType === 'text/csv') {
    try {
      const text = buffer.toString('utf-8');
      return {
        success: true,
        text: text,
        type: 'csv'
      };
    } catch (error) {
      return { success: false, error: `Error procesando CSV: ${error.message}` };
    }
  }

  // TXT y otros archivos de texto
  if (ext === 'txt' || ext === 'md' || ext === 'json' || ext === 'xml' ||
      mimeType?.startsWith('text/') || mimeType === 'application/json') {
    try {
      const text = buffer.toString('utf-8');
      return {
        success: true,
        text: text,
        type: ext
      };
    } catch (error) {
      return { success: false, error: `Error procesando archivo de texto: ${error.message}` };
    }
  }

  return {
    success: false,
    error: `Tipo de archivo no soportado: ${ext} (${mimeType})`
  };
}

/**
 * Endpoint para subir archivos y extraer texto
 * POST /upload-file
 * Body: {
 *   file: string (base64),
 *   filename: string,
 *   mimeType?: string,
 *   uploadToRag?: boolean,
 *   knowledgeId?: string
 * }
 *
 * Soporta: PDF, DOCX, XLSX, XLS, CSV, TXT, MD, JSON, XML
 */
app.post('/upload-file', async (req, res) => {
  try {
    const { file, filename, mimeType, uploadToRag, knowledgeId } = req.body;
    const apiKey = getApiKey(req.body.apiKey);
    const kbId = knowledgeId || OPENWEBUI_KNOWLEDGE_ID;

    if (!file) {
      return res.status(400).json({ error: 'file (base64) is required' });
    }

    if (!filename) {
      return res.status(400).json({ error: 'filename is required' });
    }

    console.log(`[Upload] Procesando archivo: ${filename}`);

    // Decodificar base64
    const buffer = Buffer.from(file, 'base64');
    console.log(`[Upload] Tamaño: ${buffer.length} bytes`);

    // Extraer texto del archivo
    const extraction = await extractTextFromFile(buffer, filename, mimeType);

    if (!extraction.success) {
      return res.status(400).json({
        success: false,
        error: extraction.error,
        filename: filename
      });
    }

    // Si es PDF y necesita subirse a Open WebUI para procesamiento
    if (extraction.uploadToOpenWebUI && uploadToRag && apiKey) {
      console.log(`[Upload] Subiendo PDF a Open WebUI para procesamiento...`);

      // Usar el flujo existente de upload a Open WebUI
      const uploadResult = await new Promise((resolve, reject) => {
        const formData = new FormData();
        formData.append('file', buffer, {
          filename: filename,
          contentType: 'application/pdf',
          knownLength: buffer.length
        });

        const uploadUrl = new URL(`${OPENWEBUI_URL}/api/v1/files/`);
        const options = {
          protocol: uploadUrl.protocol,
          host: uploadUrl.hostname,
          port: uploadUrl.port || (uploadUrl.protocol === 'https:' ? 443 : 80),
          path: uploadUrl.pathname,
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            ...formData.getHeaders()
          }
        };

        const httpModule = uploadUrl.protocol === 'https:' ? require('https') : require('http');

        const req = httpModule.request(options, (response) => {
          let data = '';
          response.on('data', chunk => data += chunk);
          response.on('end', () => {
            if (response.statusCode >= 200 && response.statusCode < 300) {
              try {
                resolve(JSON.parse(data));
              } catch (e) {
                reject(new Error(`Error parseando respuesta: ${data}`));
              }
            } else {
              reject(new Error(`Error subiendo: ${response.statusCode} - ${data}`));
            }
          });
        });

        req.on('error', (error) => {
          reject(new Error(`Error de conexión: ${error.message}`));
        });

        formData.pipe(req);
      });

      // Agregar a Knowledge Base si se especificó
      let knowledgeResult = null;
      if (kbId) {
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
        }
      }

      return res.json({
        success: true,
        filename: filename,
        type: extraction.type,
        text: null,
        message: 'PDF subido a Open WebUI para procesamiento',
        uploadedToRag: true,
        fileId: uploadResult.id,
        knowledgeBase: knowledgeResult
      });
    }

    // Subir a RAG si se solicita y hay texto extraído
    let ragResult = null;
    if (uploadToRag && apiKey && extraction.text) {
      console.log(`[Upload] Subiendo texto extraído a RAG...`);

      // Crear archivo de texto con el contenido extraído
      const textBuffer = Buffer.from(extraction.text, 'utf-8');
      const textFilename = filename.replace(/\.[^.]+$/, '.txt');

      const uploadResult = await new Promise((resolve, reject) => {
        const formData = new FormData();
        formData.append('file', textBuffer, {
          filename: textFilename,
          contentType: 'text/plain',
          knownLength: textBuffer.length
        });

        const uploadUrl = new URL(`${OPENWEBUI_URL}/api/v1/files/`);
        const options = {
          protocol: uploadUrl.protocol,
          host: uploadUrl.hostname,
          port: uploadUrl.port || (uploadUrl.protocol === 'https:' ? 443 : 80),
          path: uploadUrl.pathname,
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            ...formData.getHeaders()
          }
        };

        const httpModule = uploadUrl.protocol === 'https:' ? require('https') : require('http');

        const req = httpModule.request(options, (response) => {
          let data = '';
          response.on('data', chunk => data += chunk);
          response.on('end', () => {
            if (response.statusCode >= 200 && response.statusCode < 300) {
              try {
                resolve(JSON.parse(data));
              } catch (e) {
                reject(new Error(`Error parseando respuesta: ${data}`));
              }
            } else {
              reject(new Error(`Error subiendo: ${response.statusCode} - ${data}`));
            }
          });
        });

        req.on('error', (error) => {
          reject(new Error(`Error de conexión: ${error.message}`));
        });

        formData.pipe(req);
      });

      ragResult = { fileId: uploadResult.id, filename: textFilename };

      // Agregar a Knowledge Base si se especificó
      if (kbId) {
        const addToKbResponse = await fetch(`${OPENWEBUI_URL}/api/v1/knowledge/${kbId}/file/add`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ file_id: uploadResult.id })
        });

        if (addToKbResponse.ok) {
          ragResult.knowledgeBase = await addToKbResponse.json();
        }
      }
    }

    console.log(`[Upload] Procesamiento exitoso: ${extraction.type}, ${extraction.text?.length || 0} caracteres`);

    res.json({
      success: true,
      filename: filename,
      type: extraction.type,
      text: extraction.text,
      textLength: extraction.text?.length || 0,
      sheets: extraction.sheets || null,
      sheetNames: extraction.sheetNames || null,
      uploadedToRag: !!ragResult,
      ragResult: ragResult
    });

  } catch (error) {
    console.error('[Upload] Error:', error.message);
    res.status(500).json({
      success: false,
      error: 'Error procesando archivo',
      message: error.message
    });
  }
});

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

    // 2. Subir a Open WebUI Files API usando form-data submit (más confiable que fetch)
    console.log(`[RAG] Subiendo a Open WebUI: ${OPENWEBUI_URL} (${pdfBuffer.length} bytes)`);

    const uploadResult = await new Promise((resolve, reject) => {
      const formData = new FormData();
      formData.append('file', pdfBuffer, {
        filename: pdfFilename,
        contentType: 'application/pdf',
        knownLength: pdfBuffer.length
      });

      const uploadUrl = new URL(`${OPENWEBUI_URL}/api/v1/files/`);
      const options = {
        protocol: uploadUrl.protocol,
        host: uploadUrl.hostname,
        port: uploadUrl.port || (uploadUrl.protocol === 'https:' ? 443 : 80),
        path: uploadUrl.pathname,
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          ...formData.getHeaders()
        }
      };

      const httpModule = uploadUrl.protocol === 'https:' ? require('https') : require('http');

      const req = httpModule.request(options, (response) => {
        let data = '';
        response.on('data', chunk => data += chunk);
        response.on('end', () => {
          if (response.statusCode >= 200 && response.statusCode < 300) {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(new Error(`Error parseando respuesta: ${data}`));
            }
          } else {
            reject(new Error(`Error subiendo a Open WebUI: ${response.statusCode} - ${data}`));
          }
        });
      });

      req.on('error', (error) => {
        reject(new Error(`Error de conexión: ${error.message}`));
      });

      formData.pipe(req);
    });
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
    // Usar el modelo especificado, o el configurado en env, o dejar que Open WebUI use el default
    const modelToUse = model || OPENWEBUI_MODEL;
    const requestBody = {
      messages: [
        {
          role: 'user',
          content: query
        }
      ],
      stream: false
    };

    // Solo incluir model si hay uno especificado
    if (modelToUse) {
      requestBody.model = modelToUse;
    }

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
 * Debug RAG: Muestra información detallada de la Knowledge Base
 * GET /debug-rag
 */
app.get('/debug-rag', async (req, res) => {
  try {
    const apiKey = getApiKey(req.query.apiKey);
    const kbId = req.query.knowledgeId || OPENWEBUI_KNOWLEDGE_ID;

    if (!apiKey) {
      return res.status(400).json({ error: 'API Key not configured' });
    }

    if (!kbId) {
      return res.status(400).json({ error: 'Knowledge Base ID not configured' });
    }

    console.log(`[DEBUG-RAG] Diagnosticando KB: ${kbId}`);

    const debug = {
      knowledgeBaseId: kbId,
      openwebuiUrl: OPENWEBUI_URL,
      checks: {}
    };

    // 1. Obtener info de la Knowledge Base
    try {
      const kbResponse = await fetch(`${OPENWEBUI_URL}/api/v1/knowledge/${kbId}`, {
        headers: { 'Authorization': `Bearer ${apiKey}` }
      });

      if (kbResponse.ok) {
        const kbData = await kbResponse.json();
        debug.checks.knowledgeBase = {
          status: 'ok',
          name: kbData.name,
          description: kbData.description,
          filesCount: kbData.files?.length || 0,
          files: (kbData.files || []).map(f => ({
            id: f.id,
            filename: f.filename || f.meta?.name,
            size: f.meta?.size,
            contentType: f.meta?.content_type
          })),
          data: kbData.data || null
        };
      } else {
        debug.checks.knowledgeBase = {
          status: 'error',
          statusCode: kbResponse.status,
          error: await kbResponse.text()
        };
      }
    } catch (err) {
      debug.checks.knowledgeBase = { status: 'error', error: err.message };
    }

    // 2. Probar endpoint de retrieval con diferentes formatos
    const testQuery = 'test';
    const collectionFormats = [
      kbId,                          // ID directo
      `knowledge_${kbId}`,           // Con prefijo knowledge_
      `kb_${kbId}`,                  // Con prefijo kb_
    ];

    debug.checks.retrievalTests = [];

    for (const collectionName of collectionFormats) {
      try {
        const retrievalResponse = await fetch(`${OPENWEBUI_URL}/api/v1/retrieval/query`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            collection_names: [collectionName],
            query: testQuery,
            k: 3
          })
        });

        const retrievalData = retrievalResponse.ok ? await retrievalResponse.json() : await retrievalResponse.text();

        debug.checks.retrievalTests.push({
          collectionName,
          status: retrievalResponse.ok ? 'ok' : 'error',
          statusCode: retrievalResponse.status,
          documentsCount: retrievalResponse.ok ? (retrievalData.documents?.length || retrievalData.results?.length || 0) : 0,
          response: retrievalResponse.ok ? retrievalData : retrievalData.substring(0, 200)
        });
      } catch (err) {
        debug.checks.retrievalTests.push({
          collectionName,
          status: 'error',
          error: err.message
        });
      }
    }

    // 3. Obtener contenido de los archivos directamente
    if (debug.checks.knowledgeBase?.files?.length > 0) {
      debug.checks.fileContents = [];

      for (const file of debug.checks.knowledgeBase.files.slice(0, 3)) {
        try {
          const fileResponse = await fetch(`${OPENWEBUI_URL}/api/v1/files/${file.id}`, {
            headers: { 'Authorization': `Bearer ${apiKey}` }
          });

          if (fileResponse.ok) {
            const fileData = await fileResponse.json();
            debug.checks.fileContents.push({
              fileId: file.id,
              filename: file.filename,
              hasContent: !!(fileData.data?.content),
              contentLength: fileData.data?.content?.length || 0,
              contentPreview: fileData.data?.content?.substring(0, 300) || 'No content'
            });
          } else {
            debug.checks.fileContents.push({
              fileId: file.id,
              filename: file.filename,
              status: 'error',
              statusCode: fileResponse.status
            });
          }
        } catch (err) {
          debug.checks.fileContents.push({
            fileId: file.id,
            filename: file.filename,
            status: 'error',
            error: err.message
          });
        }
      }
    }

    // 4. Listar TODOS los archivos de Open WebUI (no solo los de la KB)
    try {
      const allFilesResponse = await fetch(`${OPENWEBUI_URL}/api/v1/files/`, {
        headers: { 'Authorization': `Bearer ${apiKey}` }
      });

      if (allFilesResponse.ok) {
        const allFiles = await allFilesResponse.json();
        debug.checks.allOpenWebUIFiles = {
          status: 'ok',
          totalCount: allFiles.length,
          files: allFiles.slice(0, 10).map(f => ({
            id: f.id,
            filename: f.filename || f.meta?.name,
            created_at: f.created_at,
            size: f.meta?.size,
            contentType: f.meta?.content_type
          }))
        };

        // Obtener contenido del primer archivo si existe
        if (allFiles.length > 0) {
          const firstFile = allFiles[0];
          try {
            const firstFileResponse = await fetch(`${OPENWEBUI_URL}/api/v1/files/${firstFile.id}`, {
              headers: { 'Authorization': `Bearer ${apiKey}` }
            });
            if (firstFileResponse.ok) {
              const firstFileData = await firstFileResponse.json();
              debug.checks.firstFileContent = {
                fileId: firstFile.id,
                filename: firstFile.filename || firstFile.meta?.name,
                hasContent: !!(firstFileData.data?.content),
                contentLength: firstFileData.data?.content?.length || 0,
                contentPreview: firstFileData.data?.content?.substring(0, 500) || 'No content'
              };
            }
          } catch (err) {
            debug.checks.firstFileContent = { status: 'error', error: err.message };
          }
        }
      } else {
        debug.checks.allOpenWebUIFiles = {
          status: 'error',
          statusCode: allFilesResponse.status
        };
      }
    } catch (err) {
      debug.checks.allOpenWebUIFiles = { status: 'error', error: err.message };
    }

    console.log(`[DEBUG-RAG] Diagnóstico completado`);
    res.json(debug);

  } catch (error) {
    console.error('[DEBUG-RAG] Error:', error.message);
    res.status(500).json({
      error: 'Error en diagnóstico RAG',
      message: error.message
    });
  }
});

/**
 * Retrieval-only: Obtiene fragmentos relevantes sin generación
 * POST /retrieve-only
 * Body: { query: string, knowledgeId?: string, topK?: number }
 *
 * Esto permite usar RAG sin necesidad de tener un modelo configurado en Open WebUI.
 * Los fragmentos retornados pueden pasarse al modelo principal del add-in (Azure OpenAI).
 */
app.post('/retrieve-only', async (req, res) => {
  try {
    const { query, knowledgeId, topK = 8 } = req.body;
    const apiKey = getApiKey(req.body.apiKey);
    const kbId = knowledgeId || OPENWEBUI_KNOWLEDGE_ID;

    if (!query) {
      return res.status(400).json({ error: 'query is required' });
    }

    if (!apiKey) {
      return res.status(400).json({ error: 'API Key not configured' });
    }

    if (!kbId) {
      return res.status(400).json({ error: 'Knowledge Base ID not configured' });
    }

    console.log(`[RAG] Retrieval-only para: "${query}" (top ${topK})`);

    // Estrategia 1: Intentar retrieval vectorial con diferentes formatos de collection_name
    const collectionFormats = [
      kbId,                    // ID directo
      `file-${kbId}`,          // Con prefijo file-
    ];

    let retrievalSuccess = false;
    let chunks = [];
    let usedMethod = 'none';

    for (const collectionName of collectionFormats) {
      if (retrievalSuccess) break;

      try {
        console.log(`[RAG] Probando collection_name: ${collectionName}`);

        const retrievalResponse = await fetch(`${OPENWEBUI_URL}/api/v1/retrieval/query`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            collection_names: [collectionName],
            query: query,
            k: topK
          })
        });

        if (retrievalResponse.ok) {
          const retrievalData = await retrievalResponse.json();
          const documents = retrievalData.documents || retrievalData.results || [];

          if (documents.length > 0) {
            chunks = documents.map((doc, index) => ({
              content: typeof doc === 'string' ? doc : (doc.content || doc.text || doc.page_content || JSON.stringify(doc)),
              metadata: typeof doc === 'object' ? (doc.metadata || {}) : {},
              score: doc.score || doc.distance || null,
              source: 'vector_search',
              collectionName: collectionName,
              index: index
            }));
            retrievalSuccess = true;
            usedMethod = 'vector_retrieval';
            console.log(`[RAG] Retrieval exitoso con ${collectionName}: ${chunks.length} documentos`);
          } else {
            console.log(`[RAG] Collection ${collectionName}: respuesta OK pero 0 documentos`);
          }
        } else {
          console.log(`[RAG] Collection ${collectionName}: error ${retrievalResponse.status}`);
        }
      } catch (err) {
        console.log(`[RAG] Collection ${collectionName}: excepción - ${err.message}`);
      }
    }

    // Estrategia 2: Si no hay resultados vectoriales, obtener contenido de archivos de la KB
    if (!retrievalSuccess || chunks.length === 0) {
      console.log(`[RAG] Retrieval vectorial sin resultados, obteniendo archivos de KB...`);

      try {
        const kbResponse = await fetch(`${OPENWEBUI_URL}/api/v1/knowledge/${kbId}`, {
          headers: { 'Authorization': `Bearer ${apiKey}` }
        });

        if (kbResponse.ok) {
          const kbData = await kbResponse.json();
          console.log(`[RAG] KB ${kbData.name}: ${kbData.files?.length || 0} archivos`);

          if (kbData.files && kbData.files.length > 0) {
            for (const file of kbData.files.slice(0, 5)) {
              try {
                const fileId = file.id || file.file_id;
                console.log(`[RAG] Obteniendo archivo de KB: ${fileId}`);

                const fileResponse = await fetch(`${OPENWEBUI_URL}/api/v1/files/${fileId}`, {
                  headers: { 'Authorization': `Bearer ${apiKey}` }
                });

                if (fileResponse.ok) {
                  const fileData = await fileResponse.json();
                  console.log(`[RAG] Archivo ${fileId}: data.content = ${fileData.data?.content ? 'SI' : 'NO'} (${fileData.data?.content?.length || 0} chars)`);

                  if (fileData.data && fileData.data.content) {
                    const content = fileData.data.content;
                    const chunkSize = 1500;

                    if (content.length <= chunkSize) {
                      chunks.push({
                        content: content,
                        filename: fileData.filename || file.filename || 'unknown',
                        fileId: fileId,
                        source: 'file_content',
                        chunkIndex: 0
                      });
                    } else {
                      const maxChunks = Math.min(Math.ceil(content.length / chunkSize), topK);
                      for (let i = 0; i < maxChunks; i++) {
                        chunks.push({
                          content: content.substring(i * chunkSize, (i + 1) * chunkSize),
                          filename: fileData.filename || file.filename || 'unknown',
                          fileId: fileId,
                          source: 'file_content',
                          chunkIndex: i
                        });
                      }
                    }
                    usedMethod = 'file_content';
                  }
                }
              } catch (err) {
                console.warn(`[RAG] Error procesando archivo de KB:`, err.message);
              }
            }
          }
        }
      } catch (err) {
        console.warn(`[RAG] Error obteniendo KB:`, err.message);
      }
    }

    // Estrategia 3: Si la KB está vacía, buscar en TODOS los archivos de Open WebUI
    if (chunks.length === 0) {
      console.log(`[RAG] KB vacía, buscando en todos los archivos de Open WebUI...`);

      try {
        const filesResponse = await fetch(`${OPENWEBUI_URL}/api/v1/files/`, {
          headers: { 'Authorization': `Bearer ${apiKey}` }
        });

        if (filesResponse.ok) {
          const allFiles = await filesResponse.json();
          console.log(`[RAG] Total archivos en Open WebUI: ${allFiles.length}`);

          // Ordenar por fecha de creación (más recientes primero) y tomar los primeros 5
          const sortedFiles = allFiles
            .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
            .slice(0, 5);

          for (const file of sortedFiles) {
            try {
              const fileId = file.id;
              console.log(`[RAG] Obteniendo archivo global: ${fileId} (${file.filename || file.meta?.name || 'unknown'})`);

              const fileResponse = await fetch(`${OPENWEBUI_URL}/api/v1/files/${fileId}`, {
                headers: { 'Authorization': `Bearer ${apiKey}` }
              });

              if (fileResponse.ok) {
                const fileData = await fileResponse.json();
                console.log(`[RAG] Archivo ${fileId}: data.content = ${fileData.data?.content ? 'SI' : 'NO'} (${fileData.data?.content?.length || 0} chars)`);

                if (fileData.data && fileData.data.content) {
                  const content = fileData.data.content;
                  const chunkSize = 1500;

                  if (content.length <= chunkSize) {
                    chunks.push({
                      content: content,
                      filename: fileData.filename || file.filename || file.meta?.name || 'unknown',
                      fileId: fileId,
                      source: 'all_files',
                      chunkIndex: 0
                    });
                  } else {
                    const maxChunks = Math.min(Math.ceil(content.length / chunkSize), topK);
                    for (let i = 0; i < maxChunks; i++) {
                      chunks.push({
                        content: content.substring(i * chunkSize, (i + 1) * chunkSize),
                        filename: fileData.filename || file.filename || file.meta?.name || 'unknown',
                        fileId: fileId,
                        source: 'all_files',
                        chunkIndex: i
                      });
                    }
                  }
                  usedMethod = 'all_files_fallback';

                  // Si ya tenemos suficientes chunks, salir
                  if (chunks.length >= topK) break;
                }
              }
            } catch (err) {
              console.warn(`[RAG] Error procesando archivo global:`, err.message);
            }
          }
        }
      } catch (err) {
        console.warn(`[RAG] Error obteniendo archivos globales:`, err.message);
      }
    }

    console.log(`[RAG] Resultado final: ${chunks.length} chunks (método: ${usedMethod})`);

    res.json({
      success: true,
      method: usedMethod,
      query: query,
      chunks: chunks,
      knowledgeBaseId: kbId,
      totalChunks: chunks.length
    });

  } catch (error) {
    console.error('[RAG] Retrieve-only error:', error.message);
    res.status(500).json({
      error: 'Error en retrieval',
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
