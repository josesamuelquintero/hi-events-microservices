#!/usr/bin/env bash
# ponytail: generates the 9 near-identical Deployment+Service manifests instead of
# hand-copying YAML 9 times. Only replicas/port/db name differ per service.
set -euo pipefail
cd "$(dirname "$0")/.."

SERVICE_URLS='
            - { name: EVENT_SERVICE_URL, value: "http://event-service:4002" }
            - { name: PRODUCT_SERVICE_URL, value: "http://product-service:4003" }
            - { name: ORDER_SERVICE_URL, value: "http://order-service:4004" }
            - { name: PAYMENT_SERVICE_URL, value: "http://payment-service:4005" }
            - { name: ATTENDEE_SERVICE_URL, value: "http://attendee-service:4006" }
            - { name: PROMO_SERVICE_URL, value: "http://promo-service:4007" }
            - { name: NOTIFICATION_SERVICE_URL, value: "http://notification-service:4008" }'

gen_service() {
  local file=$1 name=$2 port=$3 db=$4 replicas=$5
  cat > "$file" <<YAML
apiVersion: apps/v1
kind: Deployment
metadata:
  name: $name
  namespace: hievents
spec:
  replicas: $replicas
  selector:
    matchLabels: { app: $name }
  template:
    metadata:
      labels: { app: $name }
    spec:
      containers:
        - name: $name
          image: hievents/$name:local
          imagePullPolicy: IfNotPresent
          ports: [{ containerPort: $port }]
          env:
            - { name: PORT, value: "$port" }
            - { name: PGHOST, value: postgres }
            - { name: PGPORT, value: "5432" }
            - { name: PGDATABASE, value: $db }
            - { name: PGUSER, valueFrom: { secretKeyRef: { name: hievents-secrets, key: PGUSER } } }
            - { name: PGPASSWORD, valueFrom: { secretKeyRef: { name: hievents-secrets, key: PGPASSWORD } } }
            - { name: SUPABASE_URL, valueFrom: { configMapKeyRef: { name: supabase-config, key: SUPABASE_URL } } }
            - { name: SUPABASE_ANON_KEY, valueFrom: { configMapKeyRef: { name: supabase-config, key: SUPABASE_ANON_KEY } } }
            - { name: RABBITMQ_URL, value: "amqp://guest:guest@rabbitmq:5672" }$SERVICE_URLS
          readinessProbe:
            httpGet: { path: /health, port: $port }
            initialDelaySeconds: 5
            periodSeconds: 10
          resources:
            requests: { cpu: "50m", memory: "64Mi" }
            limits: { cpu: "250m", memory: "256Mi" }
---
apiVersion: v1
kind: Service
metadata:
  name: $name
  namespace: hievents
spec:
  selector: { app: $name }
  ports: [{ port: $port, targetPort: $port }]
YAML
  echo "wrote $file"
}

gen_service k8s/11-event-service.yaml event-service 4002 eventdb 2
gen_service k8s/12-product-service.yaml product-service 4003 productdb 2
gen_service k8s/13-order-service.yaml order-service 4004 orderdb 2
gen_service k8s/14-payment-service.yaml payment-service 4005 paymentdb 2
gen_service k8s/15-attendee-service.yaml attendee-service 4006 attendeedb 2
gen_service k8s/16-promo-service.yaml promo-service 4007 promodb 1
gen_service k8s/17-notification-service.yaml notification-service 4008 notifdb 1

cat > k8s/20-api-gateway.yaml <<YAML
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-gateway
  namespace: hievents
spec:
  replicas: 2
  selector:
    matchLabels: { app: api-gateway }
  template:
    metadata:
      labels: { app: api-gateway }
    spec:
      containers:
        - name: api-gateway
          image: hievents/api-gateway:local
          imagePullPolicy: IfNotPresent
          ports: [{ containerPort: 8080 }]
          env:
            - { name: PORT, value: "8080" }$SERVICE_URLS
          readinessProbe:
            httpGet: { path: /health, port: 8080 }
            initialDelaySeconds: 5
            periodSeconds: 10
          resources:
            requests: { cpu: "50m", memory: "64Mi" }
            limits: { cpu: "250m", memory: "256Mi" }
---
# NodePort so it's reachable from kind via 'kubectl port-forward' or the mapped
# host port set up in kind's cluster config. On EKS, change this to LoadBalancer
# to get a real ALB/NLB.
apiVersion: v1
kind: Service
metadata:
  name: api-gateway
  namespace: hievents
spec:
  type: NodePort
  selector: { app: api-gateway }
  ports: [{ port: 8080, targetPort: 8080, nodePort: 30080 }]
YAML
echo "wrote k8s/20-api-gateway.yaml"
