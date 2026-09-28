import "dotenv/config";
import { resolve } from "node:path";

// Lectura de variables de entorno. Se leen bajo demanda para que `ask` sobre un historial ya generado
// no exija credenciales de Chatwoot.

export function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Falta la variable de entorno ${name} (ver .env.example)`);
  return value;
}

export function optionalEnv(name: string, fallback: string): string {
  // `||` y no `??`: una línea `VAR=` en .env deja un string vacío que también debe caer al default.
  return process.env[name]?.trim() || fallback;
}

export function positiveInt(name: string, fallback: number, min = 1): number {
  const value = Number(optionalEnv(name, String(fallback)));
  if (!Number.isInteger(value) || value < min) throw new Error(`${name} debe ser un entero >= ${min}`);
  return value;
}

export const TIMEZONE = optionalEnv("TIMEZONE", "America/Bogota");
export const DATA_DIR = resolve(optionalEnv("DATA_DIR", "data"));
