# hi-events-microservices

Descomposición en microservicios inspirada en el dominio de [hi.events](https://github.com/HiEventsDev/hi.events)
(que en su forma real es un monolito Laravel). Hecho para un curso de sistemas
distribuidos: cada servicio es independiente, con su propia base de datos, y
se comunican por REST (sync) y RabbitMQ (async) según el caso.

## Servicios

| Servicio               | Puerto | DB          | Rol |
|-------------------------|--------|-------------|-----|
| api-gateway             | 8080   | -           | Único punto de entrada público, enruta por prefijo de path |
| web-login                | 8081   | -           | Página de login (Google, vía Supabase Auth) |
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

**Auth:** no hay un `auth-service` casero — el login (incluyendo "Continuar con
Google") lo maneja Supabase Auth directamente. `web-login` es una página
estática que llama a `supabase-js` para hacer el OAuth con Google y te muestra
el JWT resultante. `event-service`, `product-service` y `promo-service`
verifican ese JWT contra las llaves públicas de Supabase (JWKS,
`https://<proyecto>.supabase.co/auth/v1/.well-known/jwks.json`) — no comparten
ningún secreto con Supabase, solo la URL del proyecto.

## Antes de probar el login: autorizar las Redirect URLs en Supabase

Supabase solo redirige de vuelta a URLs que tú autorizaste — si no lo haces,
el login con Google falla justo después de que Google te pide el consentimiento.

Ve a [Authentication → URL Configuration](https://supabase.com/dashboard/project/jxmpnejzcaewmcsconka/auth/url-configuration)
y agrega en **Redirect URLs**:
- `http://localhost:8081/**` (para probar con Docker Compose)
- `http://<IP-de-tu-VM>:30081/**` (para probar en Hetzner/k3s)

## Correr local con Docker Compose

```bash
docker compose up --build
```

Abre `http://localhost:8081`, entra con Google, y copia el token que te muestra
la página — es tu `Bearer` para las llamadas al gateway (`http://localhost:8080/api/...`).

## Correr en Kubernetes (kind)

```bash
kind create cluster --name hievents --config kind/kind-cluster.yaml
./scripts/build-all.sh
./scripts/kind-load.sh hievents

kubectl apply -f k8s/00-namespace.yaml -f k8s/01-secrets.yaml
kubectl apply -f k8s/02-postgres.yaml -f k8s/03-rabbitmq.yaml
kubectl -n hievents wait --for=condition=available deploy/postgres deploy/rabbitmq --timeout=120s
kubectl apply -f k8s/
kubectl -n hievents get pods -w   # ctrl-C cuando todo esté Running
```

El gateway queda expuesto en `localhost:8080` (mapeado por `kind/kind-cluster.yaml`).

## Desplegar en tu propia VM (Hetzner, k3s)

Con una VM Ubuntu que ya tiene Docker, esto es lo más simple: k3s es Kubernetes
real (un solo binario) y construyes las imágenes en la misma VM, sin necesidad
de cuenta en ningún registry.

```bash
# 1. Instalar k3s (Kubernetes de un solo nodo)
curl -sfL https://get.k3s.io | sh -
sudo k3s kubectl get node   # debería salir "Ready"

# Atajo para no escribir 'sudo k3s kubectl' cada vez:
alias kubectl='sudo k3s kubectl'

# 2. Clonar el repo y construir las imágenes con el Docker que ya tienes
git clone https://github.com/josesamuelquintero/hi-events-microservices.git
cd hi-events-microservices
./scripts/build-all.sh

# 3. Importar las imágenes al containerd de k3s (no comparte el Docker daemon de la VM)
./scripts/k3s-import.sh

# 4. Aplicar los manifiestos (los mismos que en kind, sin el archivo kind-cluster.yaml)
kubectl apply -f k8s/00-namespace.yaml -f k8s/01-secrets.yaml
kubectl apply -f k8s/02-postgres.yaml -f k8s/03-rabbitmq.yaml
kubectl -n hievents wait --for=condition=available deploy/postgres deploy/rabbitmq --timeout=120s
kubectl apply -f k8s/
kubectl -n hievents get pods -w   # ctrl-C cuando todo esté Running
```

### Abrir los puertos para llegar desde afuera

El gateway usa el `NodePort` 30080 y la página de login el 30081. Hay que
abrir **ambos**, en **dos** lados (los dos filtran tráfico):

```bash
# firewall del propio Ubuntu (si ufw está activo)
sudo ufw allow 30080/tcp
sudo ufw allow 30081/tcp
```

y en el **Hetzner Cloud Firewall** (panel web, o `hcloud firewall add-rule`):
permitir TCP entrante a los puertos `30080` y `30081` desde `0.0.0.0/0` (o
solo tu IP, si no necesitas que otros lo vean).

Prueba desde tu máquina: `curl http://<IP-pública-de-la-VM>:30080/health`.

### Actualizar tras un cambio de código

```bash
git pull
./scripts/build-all.sh
./scripts/k3s-import.sh
kubectl -n hievents rollout restart deployment/<nombre-del-servicio-que-cambió>
# o, para reiniciar todos: kubectl -n hievents rollout restart deployment --all
```

## Flujo de demo end-to-end

```bash
BASE=http://localhost:8080/api

# 1. Login: abre http://localhost:8081 (o http://<IP-VM>:30081), entra con
#    Google, y pega aquí el token que te muestra la página
TOKEN="<pega el JWT de web-login>"

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
- `web-login` solo maneja Google. Email/password, magic links, etc. son
  soportados por Supabase Auth igual, pero no hay botón para ellos en la
  página — agregarlo es una llamada más a `supabase-js`, no un servicio nuevo.
