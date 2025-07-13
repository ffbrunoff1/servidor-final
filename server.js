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
    // Tentar pnpm primeiro
    await runCommand('pnpm', ['install'], projectDir);
  } catch (error) {
    logger.warn('pnpm install falhou, tentando npm install...', { projectDir, error: error.message });
    try {
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
      
      // Injetar base URL no vite.config.js
      let newConfigContent = originalConfigContent;
      if (newConfigContent.includes('defineConfig({')) {
        newConfigContent = newConfigContent.replace(
          /defineConfig\(\{/,
          `defineConfig({\n  base: '/preview/${previewId}/dist/',`
        );
      } else {
        // Se não encontrar defineConfig, adicionar base no final do objeto
        newConfigContent = newConfigContent.replace(
          /export default \{/,
          `export default {\n  base: '/preview/${previewId}/dist/',`
        );
      }
      
      await fs.writeFile(viteConfigPath, newConfigContent);
      logger.info(`vite.config.js modificado para incluir base URL`, { projectDir, previewId });
      
    } else if (await fs.access(astroConfigPath).then(() => true).catch(() => false)) {
      configPath = astroConfigPath;
      originalConfigContent = await fs.readFile(astroConfigPath, 'utf-8');
      
      // Injetar base URL no astro.config.mjs
      const newConfigContent = originalConfigContent.replace(
        /defineConfig\(\{/,
        `defineConfig({\n  base: '/preview/${previewId}/dist/',`
      );
      
      await fs.writeFile(astroConfigPath, newConfigContent);
      logger.info(`astro.config.mjs modificado para incluir base URL`, { projectDir, previewId });
    }

    // Executar build
    try {
      await runCommand('pnpm', ['run', 'build'], projectDir);
    } catch (error) {
      logger.warn('pnpm run build falhou, tentando npm run build...', { projectDir, error: error.message });
      await runCommand('npm', ['run', 'build'], projectDir);
    }
    
  } finally {
    // Restaurar arquivo de configuração original
    if (originalConfigContent && configPath) {
      try {
        await fs.writeFile(configPath, originalConfigContent);
        logger.info('Arquivo de configuração restaurado', { projectDir });
      } catch (error) {
        logger.warn('Erro ao restaurar arquivo de configuração', { error: error.message });
      }
    }
  }
};

// Rotas
app.get('/', (req, res) => {
  res.json({ 
    message: '🚀 Servidor de preview funcionando!',
    version: '1.0.0',
    endpoints: {
      build: 'POST /build',
      health: 'GET /health',
      preview: 'GET /preview/:id/dist/'
    }
  });
});

app.get('/health', async (req, res) => {
  try {
    const stats = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: Math.round(process.uptime()),
      memory: process.memoryUsage(),
      version: '1.0.0'
    };
    
    res.json(stats);
  } catch (error) {
    logger.error('Erro no health check', { error: error.message });
    res.status(500).json({ status: 'unhealthy', error: error.message });
  }
});

app.post('/build', async (req, res) => {
  const startTime = Date.now();
  let projectDir = null;
  
  try {
    logger.info('Requisição de build recebida');
    
    // Validar payload
    const { error, value } = buildPayloadSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ 
        error: 'Payload inválido', 
        details: error.details.map(d => d.message) 
      });
    }
    
    const { files } = value;
    const id = nanoid();
    projectDir = path.join(config.previewsDir, id);
    
    logger.info('Criando projeto de preview', { id, fileCount: Object.keys(files).length });
    
    // Criar estrutura de arquivos
    await Promise.all(
      Object.entries(files).map(async ([filePath, content]) => {
        const fullPath = path.join(projectDir, filePath);
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.writeFile(fullPath, content);
      })
    );
    
    // Detectar tipo de projeto
    const projectType = detectProjectType(files);
    logger.info('Tipo de projeto detectado', { projectType, id });
    
    // Instalar dependências
    await installDependencies(projectDir);
    
    // Executar build
    await runBuild(projectDir, id, projectType);
    
    // Verificar se o build foi criado
    const distDir = path.join(projectDir, 'dist');
    const buildExists = await fs.access(distDir).then(() => true).catch(() => false);
    
    if (!buildExists) {
      throw new Error('Build não foi gerado na pasta dist');
    }
    
    const buildTime = Date.now() - startTime;
    const previewUrl = `${req.protocol}://${req.get('host')}/preview/${id}/dist/`;
    
    logger.info('Preview criado com sucesso', { 
      id, 
      projectType, 
      buildTime: `${buildTime}ms`,
      previewUrl 
    });
    
    res.json({
      success: true,
      data: {
        projectId: id,
        url: previewUrl,
        projectType,
        buildTime,
        fileCount: Object.keys(files).length
      }
    });
    
  } catch (error) {
    logger.error('Erro ao gerar preview', { 
      error: error.message, 
      stack: error.stack,
      projectDir 
    });
    
    // Limpar diretório em caso de erro
    if (projectDir) {
      try {
        await fs.rm(projectDir, { recursive: true, force: true });
      } catch (cleanupError) {
        logger.warn('Erro ao limpar diretório após falha', { cleanupError: cleanupError.message });
      }
    }
    
    res.status(500).json({
      error: 'Erro no build',
      message: error.message,
      buildTime: Date.now() - startTime
    });
  }
});

// Servir arquivos estáticos dos previews
app.use('/preview/:id/dist', express.static(config.previewsDir, {
  setHeaders: (res, filePath) => {
    // Extrair ID do preview da URL
    const urlParts = res.req.url.split('/');
    const previewId = urlParts[2]; // /preview/:id/dist/...
    
    // Construir caminho correto para o arquivo
    const relativePath = urlParts.slice(4).join('/'); // Remover /preview/:id/dist/
    const actualPath = path.join(config.previewsDir, previewId, 'dist', relativePath);
    
    // Definir headers apropriados
    if (filePath.endsWith('.html')) {
      res.setHeader('Content-Type', 'text/html');
    } else if (filePath.endsWith('.js')) {
      res.setHeader('Content-Type', 'application/javascript');
    } else if (filePath.endsWith('.css')) {
      res.setHeader('Content-Type', 'text/css');
    }
    
    res.setHeader('Cache-Control', 'public, max-age=3600');
  }
}));

// Middleware de tratamento de erros
app.use((error, req, res, next) => {
  logger.error('Erro não tratado', { 
    error: error.message, 
    stack: error.stack,
    url: req.url,
    method: req.method 
  });
  
  res.status(500).json({
    error: 'Erro interno do servidor',
    message: config.nodeEnv === 'development' ? error.message : 'Algo deu errado'
  });
});

// Limpeza automática de previews antigos
const cleanupOldPreviews = async () => {
  try {
    const entries = await fs.readdir(config.previewsDir, { withFileTypes: true });
    const now = Date.now();
    
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const dirPath = path.join(config.previewsDir, entry.name);
        const stats = await fs.stat(dirPath);
        const age = now - stats.mtime.getTime();
        
        if (age > config.previewMaxAgeMs) {
          await fs.rm(dirPath, { recursive: true, force: true });
          logger.info('Preview antigo removido', { id: entry.name, age: `${Math.round(age / 1000 / 60)}min` });
        }
      }
    }
  } catch (error) {
    logger.warn('Erro na limpeza automática', { error: error.message });
  }
};

// Iniciar limpeza automática
setInterval(cleanupOldPreviews, config.cleanupIntervalMs);

// Iniciar servidor
app.listen(config.port, config.host, () => {
  logger.info('🚀 Servidor iniciado', {
    port: config.port,
    host: config.host,
    nodeEnv: config.nodeEnv,
    previewsDir: config.previewsDir
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

