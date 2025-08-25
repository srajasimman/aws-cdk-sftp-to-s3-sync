import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { promisify } from 'node:util';

import {
  ListObjectsV2Command,
  PutObjectCommand,
  type PutObjectCommandOutput,
  S3Client,
} from '@aws-sdk/client-s3';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { EventBridgeHandler } from 'aws-lambda';
import type { FileInfo } from 'ssh2-sftp-client';
import * as sftpClient from 'ssh2-sftp-client';
import * as unzipper from 'unzipper';

// import { SplunkLogger } from '@stargate/splunk-logger';

// Promisify zlib functions
const gunzip = promisify(zlib.gunzip);

// Interface definitions
interface SftpSecret {
  SFTP_HOST: string;
  SFTP_PASSPHRASE: string;
  SFTP_USER: string;
  SFTP_DIR: string;
}

interface UploadableFile {
  buffer: Buffer;
  name: string;
}

interface ProcessingResult {
  success: boolean;
  message: string;
  processedFiles: number;
  skippedFiles: number;
}

// Custom error classes
class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

class SftpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SftpError';
  }
}

class S3Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'S3Error';
  }
}

class CompressionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompressionError';
  }
}

// Extended SFTP client with proper typing
class SftpClient extends sftpClient.default {
  async getFileBuffer(filePath: string): Promise<Buffer> {
    return super.get(filePath) as Promise<Buffer>;
  }
}

// Configuration loader
class ConfigLoader {
  static validateEnvironment(): void {
    const requiredEnvVars = ['SFTP_SECRET_NAME', 'AWS_REGION', 'S3_BUCKET'] as const;
    const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);

    if (missingVars.length > 0) {
      throw new ConfigurationError(`Missing environment variables: ${missingVars.join(', ')}`);
    }
  }

  static async loadSftpSecret(): Promise<SftpSecret> {
    const secretName = process.env.SFTP_SECRET_NAME!;
    const region = process.env.AWS_REGION!;

    const client = new SecretsManagerClient({ region });
    
    try {
      const response = await client.send(
        new GetSecretValueCommand({
          SecretId: secretName,
          VersionStage: 'AWSCURRENT',
        })
      );

      if (!response.SecretString) {
        throw new ConfigurationError('Secret string not found in response');
      }

      const secret = JSON.parse(response.SecretString) as unknown;
      
      if (
        typeof secret === 'object' &&
        secret !== null &&
        'SFTP_HOST' in secret &&
        'SFTP_PASSPHRASE' in secret &&
        'SFTP_USER' in secret &&
        'SFTP_DIR' in secret &&
        typeof (secret as SftpSecret).SFTP_HOST === 'string' &&
        typeof (secret as SftpSecret).SFTP_PASSPHRASE === 'string' &&
        typeof (secret as SftpSecret).SFTP_USER === 'string' &&
        typeof (secret as SftpSecret).SFTP_DIR === 'string'
      ) {
        return secret as SftpSecret;
      }

      throw new ConfigurationError('Invalid secret structure');
    } catch (error) {
      if (error instanceof ConfigurationError) {
        throw error;
      }
      throw new ConfigurationError(`Failed to retrieve secret: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

// File processor
class FileProcessor {
  private static readonly FILENAME_PATTERN = /UsageAcct(\d{12})\.csv/;
  private static readonly GZIP_MAGIC_HEADER = [0x1f, 0x8b];

  static isMatchingFilename(filename: string): boolean {
    return this.FILENAME_PATTERN.test(filename);
  }

  static hasGzipMagicHeader(buffer: Buffer): boolean {
    return buffer.length >= 2 && 
           buffer[0] === this.GZIP_MAGIC_HEADER[0] && 
           buffer[1] === this.GZIP_MAGIC_HEADER[1];
  }

  static removeSuffix(filename: string, suffix?: string): string {
    const suffixToRemove = suffix ?? path.extname(filename);
    return filename.endsWith(suffixToRemove) 
      ? filename.slice(0, -suffixToRemove.length) 
      : filename;
  }

  static extractTimestamp(filename: string): string | null {
    const match = this.FILENAME_PATTERN.exec(filename);
    return match ? match[1] : null;
  }

  static async validateAndDecompressGzipBuffer(
    buffer: Buffer,
    fileName: string
  ): Promise<UploadableFile> {
    if (!fileName.endsWith('.gz')) {
      return { buffer, name: fileName };
    }

    if (this.hasGzipMagicHeader(buffer)) {
      try {
        const decompressedBuffer = await gunzip(buffer);
        const decompressedFileName = this.removeSuffix(fileName, '.gz');
        return { buffer: decompressedBuffer, name: decompressedFileName };
      } catch (error) {
        throw new CompressionError(`Gzip decompression failed for ${fileName}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // Fallback for ZIP files (legacy support)
    try {
      const zip = await unzipper.Open.buffer(buffer);
      const fileEntry = zip.files.find(entry => entry.type === 'File');
      
      if (!fileEntry) {
        throw new CompressionError(`No file entries found in ZIP for ${fileName}`);
      }

      const content = await fileEntry.buffer();
      const decompressedFileName = this.removeSuffix(fileName, '.gz');
      return { buffer: content, name: decompressedFileName };
    } catch (error) {
      throw new CompressionError(`ZIP decompression failed for ${fileName}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

// S3 service
class S3Service {
  private static s3 = new S3Client({});

  static async getLatestFile(bucket: string): Promise<string | null> {
    try {
      const command = new ListObjectsV2Command({ Bucket: bucket });
      const data = await this.s3.send(command);

      if (!data.Contents || data.Contents.length === 0) {
        return null;
      }

      const latestFile = data.Contents
        .filter(item => item.Key && FileProcessor.isMatchingFilename(item.Key))
        .sort((a, b) => (b.Key ?? '').localeCompare(a.Key ?? ''))[0];

      return latestFile?.Key ?? null;
    } catch (error) {
      throw new S3Error(`Failed to fetch latest S3 file: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  static async uploadFile(bucket: string, file: UploadableFile): Promise<PutObjectCommandOutput> {
    try {
      const s3Key = `sftp_user/${file.name}`;
      const command = new PutObjectCommand({
        Body: file.buffer,
        Bucket: bucket,
        Key: s3Key,
      });

      return await this.s3.send(command);
    } catch (error) {
      throw new S3Error(`Failed to upload file ${file.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

// SFTP service
class SftpService {
  private sftp: SftpClient;

  constructor() {
    this.sftp = new SftpClient();
  }

  async connect(config: sftpClient.ConnectOptions): Promise<void> {
    try {
      await this.sftp.connect(config);
    } catch (error) {
      throw new SftpError(`Failed to connect to SFTP: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async listFiles(directory: string): Promise<FileInfo[]> {
    try {
      return await this.sftp.list(directory);
    } catch (error) {
      throw new SftpError(`Failed to list files in ${directory}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async downloadFile(filePath: string): Promise<Buffer> {
    try {
      return await this.sftp.getFileBuffer(filePath);
    } catch (error) {
      throw new SftpError(`Failed to download file ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async disconnect(): Promise<void> {
    try {
      await this.sftp.end();
    } catch (error) {
      console.warn('Failed to cleanly disconnect from SFTP:', error);
    }
  }
}

// Main processor
class SftpToS3Processor {
  private sftpService: SftpService;
  private s3Bucket: string;

  constructor(s3Bucket: string) {
    this.sftpService = new SftpService();
    this.s3Bucket = s3Bucket;
  }

  async processFiles(sftpDir: string, sftpConfig: sftpClient.ConnectOptions): Promise<ProcessingResult> {
    let processedFiles = 0;
    let skippedFiles = 0;

    try {
      await this.sftpService.connect(sftpConfig);
      const files = await this.sftpService.listFiles(sftpDir);

      const latestS3File = await S3Service.getLatestFile(this.s3Bucket);
      const latestS3Timestamp = latestS3File ? FileProcessor.extractTimestamp(latestS3File) : null;

      const processingPromises = files.map(async (file: FileInfo) => {
        if (file.type !== '-') return; // Skip non-files

        const fileTimestamp = FileProcessor.extractTimestamp(file.name);
        
        if (!fileTimestamp || (latestS3Timestamp && fileTimestamp <= latestS3Timestamp)) {
          skippedFiles++;
          console.log(`Skipping file ${file.name} - older than latest S3 file`);
          return;
        }

        try {
          const fileBuffer = await this.sftpService.downloadFile(`${sftpDir}/${file.name}`);
          const fileToUpload = await FileProcessor.validateAndDecompressGzipBuffer(fileBuffer, file.name);
          
          await S3Service.uploadFile(this.s3Bucket, fileToUpload);
          processedFiles++;
          
          console.log(`Successfully uploaded ${fileToUpload.name} to S3`);
        } catch (error) {
          console.error(`Failed to process file ${file.name}:`, error);
          // Continue processing other files even if one fails
        }
      });

      await Promise.all(processingPromises);
      
      return {
        success: true,
        message: 'Files processed successfully',
        processedFiles,
        skippedFiles
      };

    } finally {
      await this.sftpService.disconnect();
    }
  }
}

// Lambda handler
export const handler: EventBridgeHandler<'Scheduled Event', unknown, string> = async () => {
  try {
    ConfigLoader.validateEnvironment();
    
    const s3Bucket = process.env.S3_BUCKET!;
    const sftpSecret = await ConfigLoader.loadSftpSecret();
    
    const sftpConfig: sftpClient.ConnectOptions = {
      host: sftpSecret.SFTP_HOST,
      password: sftpSecret.SFTP_PASSPHRASE,
      port: 22,
      username: sftpSecret.SFTP_USER,
    };

    const processor = new SftpToS3Processor(s3Bucket);
    const result = await processor.processFiles(sftpSecret.SFTP_DIR, sftpConfig);

    // await SplunkLogger.sendToSplunk({
    //   message: result.message,
    //   timestamp: new Date().toISOString(),
    //   processedFiles: result.processedFiles,
    //   skippedFiles: result.skippedFiles,
    //   success: result.success
    // });

    return `${result.message}. Processed: ${result.processedFiles}, Skipped: ${result.skippedFiles}`;

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    // await SplunkLogger.sendToSplunk({
    //   error: errorMessage,
    //   message: 'Error transferring files',
    //   timestamp: new Date().toISOString(),
    //   success: false
    // });

    console.error('Error transferring files:', error);
    throw new Error(`Error transferring files: ${errorMessage}`);
  }
};