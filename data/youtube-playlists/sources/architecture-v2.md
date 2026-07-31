# Arquitectura V2 de playlists — AIPaths

## Qué aportan realmente al SEO y descubrimiento

### Confirmado por YouTube

1. **Las playlists pueden aparecer en resultados de búsqueda.** YouTube permite filtrar búsquedas específicamente por playlists.
2. **La búsqueda prioriza relevancia, engagement y calidad.** YouTube menciona coincidencia de título, descripción y contenido con la consulta, además del watch time/engagement para esa búsqueda. La documentación habla principalmente de videos; no promete que llenar una playlist de keywords mejore el ranking de sus videos.
3. **Las playlists de serie sí tienen una señal explícita de descubrimiento.** YouTube dice que marcar una playlist como `official series` puede hacer que otros videos de la serie sean destacados y recomendados cuando alguien mira uno de ellos, y que puede modificar cómo se presentan o descubren.
4. **Restricción:** un video sólo puede pertenecer a una playlist marcada como serie oficial. Sí puede pertenecer a múltiples playlists normales.
5. **YouTube ofrece analytics por playlist** y métricas de comportamiento dentro de ellas, por lo que se puede medir si realmente generan sesiones.

### Interpretación para AIPaths

- El valor SEO directo existe, pero es secundario: una playlist es otro resultado indexable y una forma clara de agrupar una intención de búsqueda.
- El valor más fuerte es **encadenar la siguiente reproducción correcta**, especialmente en cursos y recorridos técnicos.
- Repetir videos es correcto cuando cada playlist resuelve una intención distinta. Ejemplo: `Hermes Agent desde 0` puede estar en `Tutoriales Técnicos`, `Agentes de IA` y `Empezá Acá`.
- No conviene duplicar por duplicar. Cada playlist debe tener una promesa, un viewer y un orden distinto.

## Modelo recomendado: hubs + series

### Hubs normales

Agrupan contenido por intención. Los videos pueden repetirse entre hubs.

### Series oficiales

Sólo para recorridos que realmente deben verse en orden. Un video no puede estar en dos series oficiales, aunque sí puede seguir apareciendo en hubs normales.

---

# Playlists principales de la home

## 1. Empezá Acá: Sistemas de IA para tu Negocio

**Tipo:** hub normal. Renombra `Automatizaciones para Empresas`.

**Trabajo:** explicar la transformación completa del canal, no una herramienta.

**Orden inicial:**
1. `Metí 6 Agentes en una Mac Mini`
2. `Cómo construí un equipo usando IA`
3. `Convertí una Tarea en un Sistema de IA`
4. `No Automatices Tu Negocio Todavía`
5. `¿Cuánto Cuesta Correr 8 Agentes de IA?`
6. `Esto NO es un Chatbot: es un Agente de IA real en tu WhatsApp`
7. `Cómo crear presupuestos para clientes con IA`
8. `Creá tu web gratis en 10 minutos con IA`

**Descripción sugerida:**
> Empezá por acá para pasar de usar herramientas de IA sueltas a construir sistemas simples que operan partes reales de tu negocio. Casos, decisiones y tutoriales para recuperar tiempo y aumentar tu capacidad.

## 2. Tutoriales Técnicos de IA para Negocios

**Tipo:** hub normal. **Crear.**

**Trabajo:** capturar la intención `quiero implementarlo paso a paso`, sin importar la herramienta.

**Orden inicial:**
1. `Hermes Agent desde 0 en 27 minutos`
2. `OpenClaw desde 0 | Todo lo que Necesitas`
3. `OpenClaw: Tu Primer Agente Desde Cero`
4. `n8n Tutorial para Principiantes: Automatiza GRATIS`
5. `Cómo Crear un Chatbot de WhatsApp con IA GRATIS`
6. `WhatsApp API en Meta: Todo lo que necesitás saber 2026`
7. `Crear un Chatbot de WhatsApp con la API de Meta usando NodeJS`
8. `RAG en n8n: conectá tu agente con tus datos`
9. `Claude Code: 5 Trucos que tardé 6 meses en aprender`
10. `Context Engineering: por qué Prompt Engineering ya no alcanza`
11. `Cómo usar Gemini, Claude y ChatGPT en la terminal`
12. `Cómo conectar WhatsApp con un LLM local`

**Descripción sugerida:**
> Tutoriales técnicos y paso a paso para implementar agentes, automatizaciones, n8n, WhatsApp, Hermes, OpenClaw y Claude Code en operaciones reales de negocio.

## 3. Agentes de IA para Negocios | Hermes y OpenClaw

**Tipo:** hub normal. Renombra `Agentes de IA con OpenClaw`.

**Trabajo:** agrupar arquitectura, instalación, costos y casos de agentes.

**Orden inicial:**
1. `Metí 6 Agentes en una Mac Mini`
2. `Hermes Agent desde 0 en 27 minutos`
3. `Migré a Hermes y esto es lo que pasó con mis agentes de IA`
4. `¿Cuánto Cuesta Correr 8 Agentes de IA?`
5. `OpenClaw desde 0 | Todo lo que Necesitas`
6. `OpenClaw: Tu Primer Agente Desde Cero`
7. `Tu Agente de IA por $20 al mes`
8. `OpenClaw: El sistema que gestiona todo mi contenido`
9. `Claude Code vs OpenClaw para crear agentes IA`
10. `Esto NO es un Chatbot: es un Agente de IA real en tu WhatsApp`
11. `Simulamos una Economía de Agentes IA`

**Corrección inmediata:** sacar `ChatGPT Work cuándo usar Chat, Work o Codex`.

## 4. WhatsApp con IA para tu Negocio

**Tipo:** hub normal. Renombra `Chatbot Whatsapp` y conserva su ID por los enlaces existentes.

**Trabajo:** resultado de negocio y entrada moderna al cluster más fuerte del canal.

**Orden inicial:**
1. `Whatsapp Chatbot Crash-Course | De 0 a 100 en 60 minutos`
2. `Esto NO es un Chatbot: es un Agente de IA real en tu WhatsApp`
3. `WhatsApp API en Meta: Todo lo que necesitás saber 2026`
4. `Cómo Crear un Chatbot de WhatsApp con IA GRATIS`
5. `Chatbot de WhatsApp: agenda turnos automáticamente`
6. `WhatsApp Chatbot: Agenda Turnos SIN HABLAR CON NADIE`
7. `Crear un Chatbot con la API de Meta usando NodeJS`
8. `Whatsapp AI Bot en CLOUD 24/7`
9. `Cómo conectar WhatsApp con un LLM local`
10. `Aprende a interpretar imágenes por WhatsApp con Gemini`
11. `Vendí 20+ Chatbots y Me Arrepentí`

## 5. n8n para Automatizar tu Negocio

**Tipo:** hub normal. Renombra `N8N Automatizaciones`.

**Orden inicial:**
1. `n8n Tutorial para Principiantes: Automatiza GRATIS`
2. `Cómo Crear un Chatbot de WhatsApp con IA GRATIS`
3. `Chatbot de WhatsApp: agenda turnos automáticamente`
4. `RAG en n8n: conectá tu agente con tus datos`
5. `n8n + Gemini: automatiza noticias de IA`
6. `Esto NO es un Chatbot: es un Agente de IA real en tu WhatsApp` — sólo si la implementación mostrada usa n8n.

## 6. Claude Code para Emprendedores

**Tipo:** hub normal. Renombra `Claude Vibe Coding`.

**Orden inicial:**
1. `Claude Code: 5 Trucos que tardé 6 meses en aprender`
2. `Cómo crear presupuestos para clientes con IA`
3. `Creá tu web gratis en 10 minutos`
4. `Context Engineering: por qué Prompt Engineering ya no alcanza`
5. `Claude Code Agents vs ChatGPT: Productividad x5`
6. `Claude Code vs Cursor`
7. `¿El Vibe Coding es el FUTURO de los Developers?`
8. `Cómo usar Gemini, Claude y ChatGPT en la terminal`
9. `Construí una web completa usando Claude Code`

## 7. Casos Reales y Lecciones Construyendo con IA

**Tipo:** hub normal. **Crear.**

**Trabajo:** Historia + Autoridad; conectar con viewers que no buscan una herramienta concreta.

**Orden inicial:**
1. `Vendí 20+ Chatbots y Me Arrepentí`
2. `Metí 6 Agentes en una Mac Mini`
3. `Cómo construí un equipo usando IA`
4. `Migré a Hermes y esto es lo que pasó con mis agentes de IA`
5. `No Automatices Tu Negocio Todavía`
6. `¿Vale la pena aprender a programar en 2026?`
7. `Simulamos una Economía de Agentes IA`
8. `¿El Vibe Coding es el FUTURO de los Developers?`
9. `De Cero a Entrega: Chatbot para un Cliente`

---

# Series oficiales para crear

## 8. Curso Técnico de WhatsApp API y Chatbots

**Tipo:** serie oficial. **Crear.**

**Por qué:** hay suficiente catálogo técnico y una secuencia lógica. Es el mejor candidato para que YouTube relacione y recomiende módulos entre sí.

**Secuencia:**
1. `Whatsapp Chatbot FACIL, GRATIS y RAPIDO`
2. `Whatsapp Chatbot Crash-Course | De 0 a 100 en 60 minutos`
3. `Crear un Chatbot de WhatsApp con la API de Meta usando NodeJS`
4. `Aprende RÁPIDO a Usar la API de WhatsApp con IA en Node.js`
5. `Crea tu propio Asistente de OpenAI en WhatsApp con NodeJS`
6. `Agenda turnos por WhatsApp con Google Sheets`
7. `Cómo vincular Google Sheets con WhatsApp`
8. `Cómo agregar Botones y Listas a tu Chatbot de WhatsApp`
9. `Agrega tu chatbot a un GRUPO de WhatsApp`
10. `Whatsapp AI Bot en CLOUD 24/7`
11. `De Cero a Entrega: Chatbot para un Cliente`

Los videos pueden seguir apareciendo en los hubs `WhatsApp` y `Tutoriales Técnicos`.

## 9. Curso n8n desde Cero para Negocios

**Tipo:** serie oficial. **Crear.**

**Secuencia:**
1. `n8n Tutorial para Principiantes: Automatiza GRATIS`
2. `n8n + Gemini: automatiza noticias de IA`
3. `Cómo Crear un Chatbot de WhatsApp con IA GRATIS`
4. `Chatbot de WhatsApp: agenda turnos automáticamente`
5. `RAG en n8n: conectá tu agente con tus datos`

Los mismos videos pueden seguir en los hubs `n8n`, `WhatsApp` y `Tutoriales Técnicos`.

## No crear todavía: Hermes Agent desde Cero

Sólo hay un tutorial completo y piezas de migración/caso. Crear la serie cuando existan al menos 3 módulos claramente secuenciales: instalación, configuración/memoria y primer workflow real.

---

# Playlists secundarias, fuera de la home principal

## 10. Vender Chatbots y Servicios de IA

**Tipo:** hub normal. **Crear, pero no destacar en la home.**

Usar para preservar la demanda histórica sin convertirla en la promesa central del canal:
- `Vendí 20+ Chatbots y Me Arrepentí`
- `Método para vender chatbots de WhatsApp en 2025`
- `Guía para vender tu primer AI Chatbot para WhatsApp`
- `5 Pasos para crear un Chatbot AI | Cliente Real`
- `De Cero a Entrega: Chatbot para un Cliente`

## 11. IA Local, LLMs y GPTs

**Tipo:** renombrar la playlist `LLMs`; no destacar en la home.

Mantiene organizado el archivo sin prometer que es una línea editorial prioritaria.

## Shorts

- No usar tiempo ahora en reconstruir las 3 playlists completas.
- Sacarlas de las primeras filas de la home.
- `Shorts Claude Code` → `Shorts de Agentes y Claude Code`.
- Un Short de WhatsApp hecho con n8n debe ir a `Shorts WhatsApp`, no duplicarse automáticamente en `Shorts N8N`.
- La intención/resultados mandan sobre la herramienta secundaria.

---

# Orden recomendado de filas en la home

1. Empezá Acá: Sistemas de IA para tu Negocio
2. Tutoriales Técnicos de IA para Negocios
3. Agentes de IA para Negocios
4. WhatsApp con IA para tu Negocio
5. n8n para Automatizar tu Negocio
6. Claude Code para Emprendedores
7. Casos Reales y Lecciones Construyendo con IA

Fuera de las primeras filas: cursos largos, vender servicios, LLMs y Shorts.

# Regla operativa futura

Cada video largo debe entrar como mínimo en:
1. una playlist por **tema/herramienta**;
2. una playlist por **intención/pilar**, si aplica;
3. una sola **serie oficial**, sólo si pertenece a un recorrido secuencial.

Ejemplo:
- `Hermes Agent desde 0` → `Tutoriales Técnicos` + `Agentes de IA` + `Empezá Acá`; más adelante, una única serie oficial `Hermes Agent desde Cero`.
- `Vendí 20+ Chatbots y Me Arrepentí` → `Casos Reales` + `WhatsApp` + `Vender Chatbots`, sin serie oficial.

# Cómo medir si funcionó

Comparar 28 días antes y después por playlist:
- reproducciones iniciadas desde playlist;
- watch time generado por la playlist;
- comportamiento del viewer dentro de la playlist;
- tráfico de búsqueda hacia la playlist;
- porcentaje de viewers que pasan del primer al segundo video.

Si una playlist recibe impresiones pero no inicia sesiones, corregir nombre/primer video. Si inicia sesiones pero el segundo video pierde viewers, corregir el orden.

# Fuentes oficiales

- Series playlists: https://support.google.com/youtube/answer/6084043
- Filtros de búsqueda y búsqueda de playlists: https://support.google.com/youtube/answer/111997
- Cómo funciona YouTube Search: https://support.google.com/youtube/answer/16090438
- Analytics de playlists: https://support.google.com/youtube/answer/3529123
- Crear y administrar playlists: https://support.google.com/youtube/answer/57792
