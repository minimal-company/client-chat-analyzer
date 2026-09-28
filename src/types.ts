export interface ChatwootAttachment {
  id: number;
  file_type: string; // "audio" | "image" | "video" | "file" | "location" | "contact" | ...
  data_url: string; // "" si el archivo no llegó a guardarse (p. ej. media de WhatsApp que falló)
  extension?: string | null;
  content_type?: string | null;
  file_size?: number | null;
  transcribed_text?: string | null; // solo audio, si Chatwoot tiene activa su propia transcripción
  local_path?: string; // archivo en disco (exportación de WhatsApp): tiene prioridad sobre data_url
  coordinates_lat?: number | null;
  coordinates_long?: number | null;
  fallback_title?: string | null;
}

export interface ChatwootSender {
  id?: number;
  name?: string;
  type?: string; // "contact" | "user" | "agent_bot"
}

export interface ChatwootMessage {
  id: number;
  content: string | null;
  message_type: number; // 0 = incoming (cliente), 1 = outgoing (agente), 2 = activity, 3 = template
  private?: boolean; // notas internas: el cliente nunca las ve
  created_at: number; // epoch en segundos
  conversation_id?: number;
  source_id?: string | null; // "WAID:<id del mensaje en WhatsApp>" en mensajes que pasaron por Evolution
  /** "whatsapp": el mensaje está en WhatsApp (Evolution) pero nunca llegó a Chatwoot. */
  origin?: "whatsapp";
  content_attributes?: { deleted?: boolean } | null;
  sender?: ChatwootSender | null;
  attachments?: ChatwootAttachment[];
}

export interface ChatwootConversation {
  id: number; // display_id: es el que usa la API en /conversations/:id
  created_at: number; // epoch en segundos
}

export interface ChatwootContact {
  id: number;
  name?: string | null;
  phone_number?: string | null;
  email?: string | null;
  identifier?: string | null; // Evolution suele guardar acá el JID de WhatsApp (…@s.whatsapp.net o …@lid)
}
