import 'dotenv/config';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import * as express from 'express';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ limit: '50mb', extended: true }));

  // ✅ CORS middleware (สำคัญสำหรับ Vercel)
  const allowedOrigins = [
    'http://localhost:3000',
    'https://rp-trr-client-twxn.vercel.app',
  ];

  app.use((req, res, next) => {
    const origin = req.headers.origin as string;

    if (allowedOrigins.includes(origin)) {
      res.header('Access-Control-Allow-Origin', origin);
    }

    res.header(
      'Access-Control-Allow-Headers',
      'Origin, X-Requested-With, Content-Type, Accept, Authorization',
    );
    res.header(
      'Access-Control-Allow-Methods',
      'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    );
    res.header('Access-Control-Allow-Credentials', 'true');

    // ✅ ตอบ preflight ทันที
    if (req.method === 'OPTIONS') {
      return res.sendStatus(204);
    }

    next();
  });

  // (เปิด CORS แบบ static ไว้ให้ Nest รู้)
  app.enableCors({
    origin: allowedOrigins,
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      skipMissingProperties: true,
    }),
  );

  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  await app.listen(port);
}

bootstrap();
