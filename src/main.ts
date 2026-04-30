import * as dotenv from 'dotenv';
dotenv.config();

import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import * as bodyParser from 'body-parser';

async function bootstrap() {
  console.log('🔍 Environment check:');
  console.log('  JWT_SECRET:', process.env.JWT_SECRET ? 'Loaded' : 'NOT LOADED');
  console.log('  NODE_ENV:', process.env.NODE_ENV);
  console.log('  PORT:', process.env.PORT);
  
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
    logger: ['error', 'warn', 'log', 'debug', 'verbose'],
  });

  // 10MB limit for screenshot uploads (MUST be before CORS)
  app.use(bodyParser.json({ limit: '10mb' }));
  app.use(bodyParser.urlencoded({ limit: '10mb', extended: true }));

  app.enableCors({
    origin: '*',
    credentials: true,
  });

  app.setGlobalPrefix('api');

  // Removed verbose request logging for cleaner output

  // Serve static files from public/downloads directory
  const downloadsPath = join(__dirname, '..', 'public', 'downloads');
  app.useStaticAssets(downloadsPath, {
    prefix: '/downloads',
  });

  // Serve screenshots from public/screenshots directory
  const screenshotsPath = join(__dirname, '..', 'public', 'screenshots');
  app.useStaticAssets(screenshotsPath, {
    prefix: '/screenshots',
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  const port = process.env.PORT || 3001;
  await app.listen(port);

  console.log(`🔐 JWT_SECRET loaded: ${process.env.JWT_SECRET ? 'YES' : 'NO'}`);
  console.log(`🚀 Backend API running on http://localhost:${port}/api`);
  console.log(`📦 Downloads available at http://localhost:${port}/downloads/`);
  console.log(`📸 Screenshots available at http://localhost:${port}/screenshots/`);
  
  // Memory monitoring (every 60 seconds)
  setInterval(() => {
    const used = process.memoryUsage();
    const memoryStats = {
      rss: `${Math.round(used.rss / 1024 / 1024)}MB`,
      heapUsed: `${Math.round(used.heapUsed / 1024 / 1024)}MB`,
      heapTotal: `${Math.round(used.heapTotal / 1024 / 1024)}MB`,
    };
    
    // Log only if memory usage is high
    if (used.heapUsed > 500 * 1024 * 1024) { // > 500MB
      console.log('📊 Memory Usage:', memoryStats);
    }
    
    // Critical memory alert
    if (used.heapUsed > 900 * 1024 * 1024) { // > 900MB
      console.error('⚠️ CRITICAL MEMORY USAGE - Consider restarting');
    }
  }, 60000);
  
  // Graceful shutdown handlers
  process.on('SIGTERM', async () => {
    console.log('\n🛑 SIGTERM received, shutting down gracefully...');
    await app.close();
    process.exit(0);
  });
  
  process.on('SIGINT', async () => {
    console.log('\n🛑 SIGINT received, shutting down gracefully...');
    await app.close();
    process.exit(0);
  });
}

bootstrap();
