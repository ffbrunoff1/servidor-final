import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { nanoid } from 'nanoid';
import { fileURLToPath } from 'url';
import winston from 'winston';
import Joi from 'joi';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Configuração
const config = {
  port: process.env.PORT || 3001,
  host: process.env.HOST || '0.0.0.0',
  nodeEnv: process.env.NODE_ENV || 'development',
  previewsDir: path.join(__dirname, 'previews'),
  logsDir: path.join(__dirname, 'logs'),
  maxFileSize: '50mb',
  maxFiles: 100,
  rateLimitWindowMs: 60 * 1000, // 1 minuto
  rateLimitMaxRequests: 60, // 60 requisições por minuto
  cleanupIntervalMs: 60 * 60 * 1000, // 1 hora
  previewMaxAgeMs: 24 * 60 * 60 * 1000, // 24 horas
  buildTimeoutMs: 5 * 60 * 1000, // 5 minutos
};

// Logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.simple()
    })
  ]
});

// Criar diretórios necessários
await fs.mkdir(config.previewsDir, { recursive: true });
await fs.mkdir(config.logsDir, { recursive: true });

const app = express();

// Middleware de segurança
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: config.rateLimitWindowMs,
  max: config.rateLimitMaxRequests,
  message: { error: 'Rate limit excedido. Tente novamente em alguns minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(limiter);

// Body parser
app.use(express.json({ limit: config.maxFileSize }));

// Validação de payload
const buildPayloadSchema = Joi.object({
  files: Joi.object().pattern(
    Joi.string().pattern(/^[a-zA-Z0-9._/-]+$/),
    Joi.string().max(1024 * 1024) // 1MB por arquivo
  ).required().max(config.maxFiles)
});

// Utilitários
const runCommand = (cmd, args, projectDir, timeout = config.buildTimeoutMs) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { 
      cwd: projectDir, 
      shell: true, 
      stdio: 'pipe',
      timeout 
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => (stdout += data.toString()));
    child.stderr.on('data', (data) => (stderr += data.toString()));

    child.on('close', (code) => {
      if (code !== 0) {
        logger.error(`Comando falhou: ${cmd} ${args.join(' ')}`, { projectDir, code, stderr });
        reject(new Error(stderr || `Comando falhou com código ${code}`));
      } else {
        logger.info(`Comando executado com sucesso: ${cmd} ${args.join(' ')}`, { projectDir });
        resolve(stdout);
      }
    });

    child.on('error', (error) => {
      logger.error(`Erro ao executar comando: ${cmd}`, { error: error.message });
      reject(error);
    });
  });

const detectProjectType = (files) => {
  if (files['package.json']) {
    try {
      const packageJson = JSON.parse(files['package.json']);
      const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
      
      if (deps.vite || deps['@vitejs/plugin-react']) return 'vite';
      if (deps.astro || deps['@astrojs/core']) return 'astro';
      if (deps['create-react-app'] || deps['react-scripts']) return 'cra';
      if (deps.vue || deps['@vue/cli']) return 'vue';
      if (deps.svelte || deps['@sveltejs/kit']) return 'svelte';
    } catch (error) {
      logger.warn('Erro ao analisar package.json', { error: error.message });
    }
  }
  
  if (files['vite.config.js'] || files['vite.config.ts']) return 'vite';
  if (files['astro.config.mjs'] || files['astro.config.js']) return 'astro';
  if (files['vue.config.js']) return 'vue';
  if (files['svelte.config.js']) return 'svelte';
  
  return 'static';
};

const installDependencies = async (projectDir) => {
  try {
    // Tentar pnpm primeiro (SEM --no-optional para permitir dependências do esbuild)
    await runCommand('pnpm', ['install'], projectDir);
  } catch (error) {
    logger.warn('pnpm install falhou, tentando npm install...', { projectDir, error: error.message });
    try {
      // Tentar npm (SEM --no-optional para permitir dependências do esbuild)
      await runCommand('npm', ['install'], projectDir);
    } catch (npmError) {
      logger.error('npm install também falhou', { projectDir, error: npmError.message });
      throw npmError;
    }
  }
};

const runBuild = async (projectDir, previewId, projectType) => {
  // Modificar configuração do Vite/Astro para incluir base URL correta
  const viteConfigPath = path.join(projectDir, 'vite.config.js');
  const astroConfigPath = path.join(projectDir, 'astro.config.mjs');
  
  let originalConfigContent = null;
  let configPath = null;
  
  try {
    if (await fs.access(viteConfigPath).then(() => true).catch(() => false)) {
      configPath = viteConfigPath;
      originalConfigContent = await fs.readFile(viteConfigPath, 'utf-8');
      
      // Injetar base URL no vite.config.js (SEM /dist/ no final)
      let newConfigContent = originalConfigContent;
      if (newConfigContent.includes('defineConfig({')) {
        newConfigContent = newConfigContent.replace(
          /defineConfig\(\{/,
          `defineConfig({\n  base: '/preview/${previewId}/',`
        );
      } else {
        // Se não encontrar defineConfig, adicionar base no final do objeto
        newConfigContent = newConfigContent.replace(
          /export default \{/,
          `export default {\n  base: '/preview/${previewId}/',`
        );
      }
      
      await fs.writeFile(viteConfigPath, newConfigContent);
      logger.info(`vite.config.js modificado para incluir base URL`, { projectDir, previewId });
      
    } else if (await fs.access(astroConfigPath).then(() => true).catch(() => false)) {
      configPath = astroConfigPath;
      originalConfigContent = await fs.readFile(astroConfigPath, 'utf-8');
      
      // Injetar base URL no astro.config.mjs (SEM /dist/ no final)
      const newConfigContent = originalConfigContent.replace(
        /defineConfig\(\{/,
        `defineConfig({\n  base: '/preview/${previewId}/',`
      );
      
      await fs.writeFile(astroConfigPath, newConfigContent);
      logger.info(`astro.config.mjs modificado para incluir base URL`, { projectDir, previewId });
    }

    // Executar build
    try {
      await runCommand('pnpm', ['run', 'build'], projectDir);
    } catch (error) {
      logger.warn('pnpm run build falhou, tentando npm run build...', { error: error.message, projectDir });
      await runCommand('npm', ['run', 'build'], projectDir);
    }

  } finally {
    // Restaurar arquivo de configuração original
    if (configPath && originalConfigContent) {
      await fs.writeFile(configPath, originalConfigContent);
      logger.info('Arquivo de configuração restaurado', { projectDir });
    }
  }
};

// Middleware para servir arquivos estáticos de preview com fallback para SPA
const servePreviewFiles = (req, res, next) => {
  const previewMatch = req.path.match(/^\/preview\/([^\/]+)\/(.*)$/);
  
  if (previewMatch) {
    const [, previewId, filePath] = previewMatch;
    const projectDir = path.join(config.previewsDir, previewId);
    const distDir = path.join(projectDir, 'dist');
    
    // Primeiro, tentar servir da pasta dist
    const distFilePath = path.join(distDir, filePath || 'index.html');
    
    fs.access(distFilePath)
      .then(() => {
        res.sendFile(distFilePath);
      })
      .catch(() => {
        // Se não encontrar na pasta dist, tentar na raiz do projeto
        const rootFilePath = path.join(projectDir, filePath || 'index.html');
        
        fs.access(rootFilePath)
          .then(() => {
            res.sendFile(rootFilePath);
          })
          .catch(() => {
            // Se ainda não encontrar e for uma SPA, servir index.html
            const indexPath = path.join(distDir, 'index.html');
            
            fs.access(indexPath)
              .then(() => {
                res.sendFile(indexPath);
              })
              .catch(() => {
                // Último recurso: tentar index.html na raiz
                const rootIndexPath = path.join(projectDir, 'index.html');
                
                fs.access(rootIndexPath)
                  .then(() => {
                    res.sendFile(rootIndexPath);
                  })
                  .catch(() => {
                    res.status(404).json({ error: 'Preview não encontrado' });
                  });
              });
          });
      });
  } else {
    next();
  }
};

// Aplicar middleware de preview
app.use(servePreviewFiles);

// Rotas
app.get('/', (req, res) => {
  res.json({ 
    message: '🚀 Servidor de preview React/Vite funcionando corretamente.',
    timestamp: new Date().toISOString(),
    version: '2.0.0'
  });
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    environment: config.nodeEnv
  });
});

app.post('/build', async (req, res) => {
  const startTime = Date.now();
  logger.info('Requisição de build recebida', { timestamp: new Date().toISOString() });

  try {
    // Validar payload
    const { error, value } = buildPayloadSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ error: 'Payload inválido', details: error.details });
    }

    const { files } = value;
    const id = nanoid();
    const projectDir = path.join(config.previewsDir, id);

    logger.info('Criando projeto de preview', { 
      fileCount: Object.keys(files).length, 
      id,
      timestamp: new Date().toISOString()
    });

    // Criar arquivos do projeto
    await Promise.all(
      Object.entries(files).map(async ([filePath, content]) => {
        const fileContent = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
        const fullPath = path.join(projectDir, filePath);
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.writeFile(fullPath, fileContent);
      })
    );

    // Detectar tipo de projeto
    const projectType = detectProjectType(files);
    logger.info('Tipo de projeto detectado', { 
      id, 
      projectType,
      timestamp: new Date().toISOString()
    });

    // Instalar dependências e fazer build
    await installDependencies(projectDir);
    await runBuild(projectDir, id, projectType);

    const buildTime = Date.now() - startTime;
    const previewUrl = `https://${req.headers.host}/preview/${id}/`;
    
    logger.info('Preview criado com sucesso', { 
      buildTime: `${buildTime}ms`, 
      id, 
      previewUrl,
      projectType,
      timestamp: new Date().toISOString()
    });

    res.json({ 
      url: previewUrl,
      id,
      projectType,
      buildTime: `${buildTime}ms`,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    const buildTime = Date.now() - startTime;
    logger.error('Erro ao gerar preview', { 
      error: error.message, 
      stack: error.stack,
      buildTime: `${buildTime}ms`,
      timestamp: new Date().toISOString()
    });
    
    res.status(500).json({ 
      error: 'Erro no build', 
      message: error.message,
      buildTime: `${buildTime}ms`,
      timestamp: new Date().toISOString()
    });
  }
});

// Middleware de tratamento de erros
app.use((error, req, res, next) => {
  logger.error('Erro não tratado', {
    error: error.message,
    stack: error.stack,
    method: req.method,
    url: req.url,
    timestamp: new Date().toISOString()
  });

  res.status(500).json({
    error: 'Erro interno do servidor',
    timestamp: new Date().toISOString()
  });
});

// Limpeza automática de previews antigos
const cleanupOldPreviews = async () => {
  try {
    const previews = await fs.readdir(config.previewsDir);
    const now = Date.now();

    for (const previewId of previews) {
      const previewPath = path.join(config.previewsDir, previewId);
      const stats = await fs.stat(previewPath);
      
      if (now - stats.mtime.getTime() > config.previewMaxAgeMs) {
        await fs.rm(previewPath, { recursive: true, force: true });
        logger.info('Preview antigo removido', { previewId });
      }
    }
  } catch (error) {
    logger.error('Erro na limpeza de previews', { error: error.message });
  }
};

// Executar limpeza periodicamente
setInterval(cleanupOldPreviews, config.cleanupIntervalMs);

// Iniciar servidor
app.listen(config.port, config.host, () => {
  logger.info('Servidor iniciado', {
    port: config.port,
    host: config.host,
    nodeEnv: config.nodeEnv,
    packageManager: 'pnpm/npm (auto-fallback)',
    timestamp: new Date().toISOString()
  });
});

// Tratamento de sinais de encerramento
process.on('SIGTERM', () => {
  logger.info('Recebido SIGTERM, encerrando servidor...');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('Recebido SIGINT, encerrando servidor...');
  process.exit(0);
});
