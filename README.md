# hi-events-microservices

Descomposición en microservicios inspirada en el dominio de [hi.events](https://github.com/HiEventsDev/hi.events)
(que en su forma real es un monolito Laravel). Hecho para un curso de sistemas
distribuidos: cada servicio es independiente, con su propia base de datos, y
se comunican por REST (sync) y RabbitMQ (async) según el caso.

## Servicios

| Servicio               | Puerto | DB          | Rol |
|-------------------------|--------|-------------|-----|
| api-gateway             | 8080   | -           | Único punto de entrada público, enruta por prefijo de path |
| auth-service            | 4001   | authdb      | Registro/login, emite JWT |
| event-service            | 4002   | eventdb     | CRUD de eventos |
| product-service          | 4003   | productdb   | Tickets/productos, reserva de stock |
| order-service            | 4004   | orderdb     | Orquesta el checkout (saga) |
| payment-service          | 4005   | paymentdb   | Cobro mock |
| attendee-service         | 4006   | attendeedb  | Genera tickets/asistentes al recibir `order.paid` |
| promo-service            | 4007   | promodb     | Códigos de descuento |
| notification-service     | 4008   | notifdb     | Consumidor async de eventos (simula emails) |

**Comunicación:**
- Sync (REST): api-gateway → servicios; order-service → product-service/payment-service/promo-service durante el checkout.
- Async (RabbitMQ, exchange `hievents`, topic): order-service publica `order.paid` → attendee-service y notification-service lo consumen de forma independiente. attendee-service publica `attendee.created`.

Esto es justo lo que vale mostrar en la tarea: **orquestación síncrona para el
camino crítico de pago** (necesitas saber si el cobro falló antes de responder)
y **event-driven para efectos secundarios** (generar tickets, notificar) que no
deben bloquear la respuesta al usuario ni acoplar order-service a cuántos
consumidores tenga.

Base de datos por servicio: comparten un único Postgres (para no gastar
recursos en el cluster local) pero cada servicio solo conoce su propia base —
aislamiento lógico, no físico. Ver el comentario `ponytail:` en `k8s/02-postgres.yaml`.

## Correr local con Docker Compose

```bash
docker compose up --build
curl -X POST localhost:8080/api/auth/register -H 'Content-Type: application/json' \
  -d '{"name":"Ana","email":"ana@test.com","password":"secret123"}'
```

## Correr en Kubernetes (kind)

```bash
kind create cluster --name hievents --config k8s/kind-cluster.yaml
./scripts/build-all.sh
./scripts/kind-load.sh hievents

kubectl apply -f k8s/00-namespace.yaml -f k8s/01-secrets.yaml
kubectl apply -f k8s/02-postgres.yaml -f k8s/03-rabbitmq.yaml
kubectl -n hievents wait --for=condition=available deploy/postgres deploy/rabbitmq --timeout=120s
kubectl apply -f k8s/
kubectl -n hievents get pods -w   # ctrl-C cuando todo esté Running
```

El gateway queda expuesto en `localhost:8080` (mapeado por `k8s/kind-cluster.yaml`).

## Flujo de demo end-to-end

```bash
BASE=http://localhost:8080/api

# 1. Registro y login
TOKEN=$(curl -s $BASE/auth/register -H 'Content-Type: application/json' \
  -d '{"name":"Organizer","email":"org@test.com","password":"secret123"}' | jq -r .token)

# 2. Crear evento
EVENT_ID=$(curl -s $BASE/events -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"title":"Tech Conf 2026","start_date":"2026-11-01T10:00:00Z"}' | jq -r .id)

# 3. Crear producto (ticket)
PRODUCT_ID=$(curl -s $BASE/events/$EVENT_ID/products -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"title":"General","price_cents":5000,"quantity_available":100}' | jq -r .id)

# 4. Comprar (dispara el saga: reserva stock -> cobra -> publica order.paid)
curl -s $BASE/orders -H 'Content-Type: application/json' \
  -d "{\"event_id\":$EVENT_ID,\"customer_email\":\"buyer@test.com\",\"items\":[{\"product_id\":$PRODUCT_ID,\"quantity\":2}]}"

# 5. Ver el ticket generado async por attendee-service
curl -s "$BASE/attendees?event_id=$EVENT_ID"

# 6. Ver que notification-service lo recibió por RabbitMQ, no por llamada directa
curl -s $BASE/notifications/logs

# Simular pago rechazado (card_token "fail") y ver que la reserva se libera:
curl -s $BASE/orders -H 'Content-Type: application/json' \
  -d "{\"event_id\":$EVENT_ID,\"customer_email\":\"buyer2@test.com\",\"card_token\":\"fail\",\"items\":[{\"product_id\":$PRODUCT_ID,\"quantity\":1}]}"
```

## Pasar de kind a AWS (EKS)

1. Crear el cluster: `eksctl create cluster --name hievents --nodes 3`.
2. Crear un repo ECR por servicio (o uno con tags distintos) y hacer
   `docker tag hievents/<svc>:local <account>.dkr.ecr.<region>.amazonaws.com/hievents-<svc>:latest`
   seguido de `docker push`.
3. Cambiar `image:` en cada manifest de `hievents/<svc>:local` a la URL de ECR,
   y `imagePullPolicy` a `Always`.
4. Cambiar el `Service` de `api-gateway` (`k8s/20-api-gateway.yaml`) de
   `NodePort` a `LoadBalancer` para obtener un ALB/NLB público.
5. Reemplazar el Postgres/RabbitMQ "a mano" por RDS y Amazon MQ (o
   simplemente subir sus `replicas`/PVCs) si esto deja de ser solo una demo.
6. `kubectl apply -f k8s/` igual que en kind — los manifests no cambian de forma,
   solo la imagen y el tipo de Service.

## Qué se dejó fuera a propósito (`ponytail:` en el código)

- Sin service mesh (Istio/Linkerd): con 9 servicios y un curso, la observabilidad
  la da `kubectl logs` + el management UI de RabbitMQ (puerto 15672). Añadir un
  mesh si se necesita mTLS o retries automáticos entre servicios.
- Sin distributed tracing (Jaeger/OpenTelemetry): el saga de checkout hace
  `console.log` simple. Añadir si el profesor pide trazabilidad cross-servicio.
- Sin transacciones distribuidas/2PC: order-service hace *orchestration saga*
  con rollback manual (`release` de stock) si el pago falla. Es el patrón real
  que se usa en producción, no una simplificación de la tarea.
- Postgres y RabbitMQ son deployments de un solo pod con `emptyDir`/sin
  persistencia: se pierden datos si el pod muere. Correcto para una demo,
  no para producción (usar StatefulSet+PVC o RDS/Amazon MQ).
