# Arquitectura: hi-events-microservices desde la óptica de sistemas distribuidos

Este documento explica las decisiones del proyecto en términos de los conceptos
de un curso de sistemas distribuidos: descomposición de servicios, consistencia,
comunicación, tolerancia a fallos y despliegue. Para instrucciones de instalación
y uso ver [README.md](README.md).

## 1. Descomposición en microservicios

El dominio se partió por **bounded context** (límite de responsabilidad de
negocio), no por capa técnica — cada servicio es dueño de un sustantivo del
negocio y de todos los verbos que actúan sobre él:

| Servicio | Bounded context | Dueño de los datos de... |
|---|---|---|
| `event-service` | Eventos | `events` |
| `product-service` | Inventario de tickets | `products`, disponibilidad/reservas |
| `order-service` | Checkout | `orders`, `order_items` — **orquesta** el flujo de compra |
| `payment-service` | Cobros | `payments` |
| `attendee-service` | Asistentes/tickets emitidos | `attendees` |
| `promo-service` | Descuentos | `promo_codes` |
| `notification-service` | Notificaciones | `notification_log` |
| `api-gateway` | Enrutamiento | — (sin estado, sin base de datos) |
| `web-login` | Interfaz | — (sin estado, sin base de datos) |

Ningún servicio consulta la base de datos de otro directamente — la única
forma de que `order-service` sepa el precio de un producto es preguntándole
a `product-service` por HTTP (`services/order-service/src/index.ts`). Esto es
lo que hace que sean *servicios* y no solo *módulos* de un monolito: el límite
de proceso obliga al límite de datos.

## 2. Comunicación entre servicios

Se usan **dos estilos deliberadamente distintos**, según si el llamador
necesita la respuesta para decidir algo ahora mismo:

### 2.1 Síncrona (REST sobre HTTP)

`api-gateway` → todos los servicios de lectura, y `order-service` →
`product-service`/`payment-service`/`promo-service` durante el checkout
(`services/order-service/src/index.ts`, función del `POST /orders`). Se usa
síncrono aquí porque **la respuesta condiciona el siguiente paso**: si el
cobro falla, no tiene sentido seguir.

Costo de este acoplamiento temporal: si `payment-service` está caído,
`order-service` también falla en ese instante (no hay degradación
elegante). Es el trade-off clásico de RPC síncrono entre servicios.

### 2.2 Asíncrona (mensajería, pub/sub)

RabbitMQ con un exchange `topic` llamado `hievents`
(`services/*/src/mq.ts`). `order-service` publica `order.paid` sin saber ni
importarle quién lo consume; `attendee-service` y `notification-service` cada
uno tiene su **propia cola** enlazada a esa routing key
(`ch.assertQueue` + `ch.bindQueue` en `mq.ts`), así que ambos reciben el mismo
evento de forma independiente — es *publish/subscribe*, no *work queue* (si
fuera una sola cola compartida, solo uno de los dos consumidores se quedaría
con cada mensaje).

Se usa async aquí porque **generar el ticket y notificar no son parte de la
decisión de si la compra fue exitosa** — son efectos secundarios que no deben
bloquear la respuesta HTTP al comprador ni acoplar `order-service` a cuántos
consumidores existan hoy (agregar un décimo consumidor de `order.paid` no
requiere tocar `order-service`).

## 3. Transacciones distribuidas: patrón Saga (orquestación)

No hay transacción ACID que abarque `product-service` + `payment-service` +
`order-service` — son bases de datos distintas, un `COMMIT` de una no puede
depender del `COMMIT` de otra. En vez de eso, `order-service` implementa una
**saga orquestada** (`services/order-service/src/index.ts`):

1. Reserva stock en `product-service` (`POST /products/:id/reserve`,
   `UPDATE ... WHERE quantity_available - quantity_sold >= $1` — atómico a
   nivel de fila, evita sobreventa bajo concurrencia).
2. Cobra en `payment-service`.
3. Si el cobro falla → **transacción compensatoria**: libera el stock
   reservado (`POST /products/:id/release`). No hay rollback automático
   como en una transacción local; cada paso exitoso necesita su propio paso
   inverso, escrito a mano.
4. Si todo sale bien → publica `order.paid` (ver §2.2).

Esto es **consistencia eventual**, no consistencia fuerte: entre el paso 2
(cobro exitoso) y el momento en que `attendee-service` procesa `order.paid`
y crea el ticket, hay una ventana de tiempo donde la orden está pagada pero
el ticket todavía no existe. El sistema converge, pero no instantáneamente.

## 4. Base de datos por servicio

Cada servicio tiene su propia base (`k8s/02-postgres.yaml`, ver el
comentario `ponytail:` ahí) — aislamiento **lógico** (bases de datos
separadas en la misma instancia física de Postgres, por costo de recursos en
un cluster de curso) en vez de aislamiento físico completo. La regla que
importa para la tarea es la misma: **ningún servicio abre una conexión a la
base de datos de otro**, `PGDATABASE` en cada Deployment de k8s apunta solo
a la propia.

Trade-off explícito: si esto fuera producción, cada base viviría en su
propia instancia (o en RDS separados) para que un pico de carga en
`order-service` no consuma I/O que `event-service` necesita.

## 5. Autenticación distribuida (identidad federada)

No hay un servicio de auth propio ni una sesión compartida entre servicios.
El login usa **OAuth2/OIDC federado**: `web-login` delega todo el flujo de
"Continuar con Google" a Supabase Auth, y el navegador termina con un **JWT
firmado por Supabase**, no por nosotros.

Cada servicio que necesita saber quién hace la petición
(`event-service`, `product-service`, `promo-service`) verifica ese JWT **sin
estado y sin llamar a ningún servicio de auth**: descarga las llaves
públicas de Supabase una vez (`services/*/src/auth.ts`,
`createRemoteJWKSet` contra `/auth/v1/.well-known/jwks.json`) y valida la
firma localmente. Esto es importante en un sistema distribuido: verificar un
JWT es una operación local (CPU), no una llamada de red por cada request —
si tuviéramos un `auth-service` propio al que cada servicio le preguntara
"¿es válido este token?", cada request de negocio dependería de la
disponibilidad de un servicio más.

## 6. API Gateway

`api-gateway` es el único punto de entrada público (`services/api-gateway/src/index.ts`).
Motivos, no solo conveniencia:
- El navegador solo necesita conocer una URL, no las 8 URLs internas de cada
  servicio (que además son nombres DNS internos de Kubernetes, no
  resolubles desde afuera del cluster).
- Los servicios internos pueden moverse, escalar o cambiar de puerto sin que
  el cliente se entere.

Lo que el gateway **no** hace aquí: no verifica JWT (eso lo hace cada
servicio, ver §5) y no agrega lógica de negocio — es un *reverse proxy* con
enrutamiento por prefijo de path, nada más. Mantenerlo así evita que se
vuelva un monolito disfrazado de gateway.

## 7. Descubrimiento de servicios

`order-service` encuentra a `product-service` en la URL literal
`http://product-service:4003` (`k8s/13-order-service.yaml`, variable de
entorno `PRODUCT_SERVICE_URL`). Eso funciona porque **Kubernetes ya es un
sistema de descubrimiento de servicios**: todo `Service` de k8s obtiene un
nombre DNS interno resuelto automáticamente al ClusterIP de los pods que
respaldan ese servicio (y balancea entre réplicas). No se necesitó un
registry externo (Eureka, Consul) porque la plataforma de orquestación ya
provee esa pieza — un ejemplo de por qué el *dónde* se despliega un sistema
distribuido cambia qué problemas hay que resolver a mano.

## 8. Tolerancia a fallos

- **Reintentos de arranque**: cuando un pod arranca, puede llegar antes que
  Postgres o RabbitMQ estén listos (no hay orden garantizado entre
  Deployments en k8s). `withRetry()` (`services/*/src/db.ts`) y el loop de
  conexión en `mq.ts` reintentan con backoff en vez de morir en el primer
  intento — el fallo es *transitorio*, no hay que tratarlo como fatal.
- **Readiness probes** (`readinessProbe: httpGet /health` en cada
  Deployment): Kubernetes no manda tráfico a un pod hasta que responde
  `/health`, y lo saca de rotación si deja de responder — evita mandar
  requests a una instancia que está reiniciando.
- **Reintentos de mensajes**: si un consumidor de RabbitMQ lanza una
  excepción procesando un mensaje, se hace `nack` con *requeue*
  (`services/*/src/mq.ts`) en vez de perder el mensaje.
- **Ausente a propósito**: no hay *circuit breaker* (tipo Hystrix/resilience4j)
  entre `order-service` y sus dependencias síncronas — con 9 servicios y
  tráfico de curso, un fallo se nota de inmediato en las pruebas; en
  producción real sí haría falta para evitar que un `payment-service` lento
  tumbe a `order-service` por saturación de conexiones.

## 9. Escalabilidad horizontal

La mayoría de los Deployments corren con `replicas: 2`
(`scripts/gen-k8s.sh`), y el `Service` de Kubernetes hace *load balancing*
round-robin entre esas réplicas automáticamente — el código de cada servicio
no sabe ni le importa cuántas copias de sí mismo existen (no guarda estado
en memoria entre requests, todo el estado vive en Postgres/RabbitMQ). Esa
propiedad — servicios *stateless* — es lo que hace posible escalar
horizontalmente sin coordinación adicional.

## 10. Despliegue y orquestación

- **Contenedores**: cada servicio es una imagen Docker independiente,
  construible y desplegable por separado (`docker build` por servicio en
  `scripts/build-all.sh`) — condición necesaria para que "microservicios"
  no sea solo una forma de organizar carpetas.
- **Orquestación**: Kubernetes (k3s en la VM de Hetzner) maneja scheduling,
  reinicio ante fallos, rolling updates (`kubectl rollout restart`, cero
  downtime porque el `Service` sigue enrutando a las réplicas viejas hasta
  que las nuevas pasan el readiness probe) y el `Ingress` (Traefik) para
  exponer el sistema en el puerto 80 sin que el cliente necesite conocer
  puertos internos.
- **Namespacing**: todo vive en el namespace `hievents`
  (`k8s/00-namespace.yaml`) — aislamiento lógico de otras cargas de trabajo
  en el mismo cluster.

## 11. Qué se dejó fuera conscientemente

Ver la sección homónima en [README.md](README.md#qué-se-dejó-fuera-a-propósito-ponytail-en-el-código):
sin service mesh, sin distributed tracing, sin transacciones 2PC (por
diseño, no por omisión — la Saga del §3 es la alternativa correcta), sin
persistencia real en Postgres/RabbitMQ. Cada una de esas omisiones es un eje
que un curso de sistemas distribuidos puede pedir profundizar por separado.
