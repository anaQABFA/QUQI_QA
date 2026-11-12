# Guía: leer los porcentajes de los proyectos desde QUQI_QA

Para el equipo que desarrolla **Fluxor**. QUQI_QA ofrece una API de **solo lectura** protegida con una llave.

## Lo que necesitan
- La **URL base** de QUQI_QA (por ejemplo `https://quqi-qa.onrender.com`).
- Una **llave de acceso**, que entrega el administrador de QUQI_QA (Administración → Integraciones). Guárdenla como variable de entorno del **servidor** de Fluxor (por ejemplo `QUQI_API_KEY`); nunca la pongan en el navegador, en el código ni en un repositorio.

## Endpoints
| Método | Ruta | Qué devuelve |
|---|---|---|
| GET | `/api/integracion/proyectos` | Todos los proyectos (abiertos y cerrados) |
| GET | `/api/integracion/proyectos?estado=abiertos` | Solo abiertos. Valores: `abiertos`, `cerrados`, `en_pruebas`, `proximo`, `backlog` |
| GET | `/api/integracion/proyectos?nombre=texto` | Proyectos cuyo nombre contiene el texto (sin distinguir mayúsculas ni tildes) |
| GET | `/api/integracion/proyectos/{id}` | Un proyecto |

Cabecera obligatoria: `Authorization: Bearer <llave>` (también se acepta `X-API-Key: <llave>`). La llave **no** se acepta en la URL.

## Ejemplo de respuesta
```json
{
  "generadoEn": "2026-11-04T21:40:12.000Z",
  "total": 1,
  "proyectos": [{
    "id": "e0x3kckhkyrtwz532ign",
    "nombre": "036. Eco-Nómina",
    "estado": "en_pruebas",
    "estadoEtiqueta": "En seguimiento",
    "cerrado": false,
    "recibidoEn": "2026-10-20",
    "inicioPruebas": "2026-10-21",
    "pctEntrega": 60,
    "pctQaCertificado": 50,
    "pctProbado": 60,
    "pctExito": 83.3,
    "casos": { "total": 100, "noAplicables": 10, "aplicables": 90, "exitosos": 45, "fallidos": 9, "bloqueados": 3, "pausados": 2, "pendientes": 31 },
    "fuentePruebas": "azure",
    "pruebasActualizadoEn": "2026-11-04T21:35:00.000Z",
    "actualizadoEn": "2026-11-04T21:35:01.000Z"
  }]
}
```

## Qué significa cada porcentaje (0 a 100, un decimal)
- **pctEntrega**: cuánto del desarrollo ya fue recibido por QA (historias y criterios recibidos, ponderado por peso).
- **pctQaCertificado**: casos exitosos / casos aplicables (total menos no aplicables).
- **pctProbado**: (exitosos + fallidos) / casos aplicables.
- **pctExito**: exitosos / (exitosos + fallidos).
- Si el proyecto aún no tiene avance de pruebas, `pctQaCertificado`, `pctProbado`, `pctExito` y `casos` vienen en `null`.
- `fuentePruebas` = `azure` cuando el proyecto tiene un plan de Azure Test Plans vinculado (se actualiza solo cada pocos minutos); `manual` cuando QA registró los conteos a mano.

## Códigos de respuesta
`200` correcto · `401` llave inválida o revocada · `404` proyecto inexistente · `405` método no permitido (solo GET) · `429` demasiadas consultas (máximo 120 por minuto por llave) o demasiados intentos con llave inválida.

Recomendación: consulten cada 5 a 15 minutos y guarden el último resultado; los datos de Azure se refrescan en QUQI cada pocos minutos, así que consultar más seguido no aporta nada.

## Ejemplos
**curl**
```bash
curl -H "Authorization: Bearer $QUQI_API_KEY" "$QUQI_URL/api/integracion/proyectos?estado=abiertos"
```

**Node.js (18+)**
```js
const r = await fetch(`${process.env.QUQI_URL}/api/integracion/proyectos`, {
  headers: { Authorization: `Bearer ${process.env.QUQI_API_KEY}` }
});
if (!r.ok) throw new Error(`QUQI respondió ${r.status}`);
const { proyectos } = await r.json();
```

**Python**
```python
import os, requests
r = requests.get(os.environ["QUQI_URL"] + "/api/integracion/proyectos",
                 headers={"Authorization": "Bearer " + os.environ["QUQI_API_KEY"]}, timeout=20)
r.raise_for_status()
proyectos = r.json()["proyectos"]
```

**Java 11+**
```java
HttpRequest req = HttpRequest.newBuilder(URI.create(System.getenv("QUQI_URL") + "/api/integracion/proyectos"))
    .header("Authorization", "Bearer " + System.getenv("QUQI_API_KEY")).GET().build();
HttpResponse<String> res = HttpClient.newHttpClient().send(req, HttpResponse.BodyHandlers.ofString());
```
