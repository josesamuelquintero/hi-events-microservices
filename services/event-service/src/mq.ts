import amqplib, { Channel, ChannelModel, ConsumeMessage } from "amqplib";

const EXCHANGE = "hievents";
let channel: Channel | null = null;

export async function getChannel(): Promise<Channel> {
  if (channel) return channel;
  const url = process.env.RABBITMQ_URL || "amqp://guest:guest@rabbitmq:5672";
  let conn: ChannelModel | null = null;
  for (let i = 1; i <= 10; i++) {
    try {
      conn = await amqplib.connect(url);
      break;
    } catch (err) {
      if (i === 10) throw err;
      await new Promise((r) => setTimeout(r, 1000 * i));
    }
  }
  channel = await conn!.createChannel();
  await channel.assertExchange(EXCHANGE, "topic", { durable: true });
  return channel;
}

export async function publish(routingKey: string, payload: unknown) {
  const ch = await getChannel();
  ch.publish(EXCHANGE, routingKey, Buffer.from(JSON.stringify(payload)), {
    contentType: "application/json",
    persistent: true,
  });
}

export async function subscribe(
  queueName: string,
  routingKeys: string[],
  handler: (routingKey: string, payload: any) => Promise<void>
) {
  const ch = await getChannel();
  await ch.assertQueue(queueName, { durable: true });
  for (const key of routingKeys) {
    await ch.bindQueue(queueName, EXCHANGE, key);
  }
  ch.consume(queueName, async (msg: ConsumeMessage | null) => {
    if (!msg) return;
    try {
      const payload = JSON.parse(msg.content.toString());
      await handler(msg.fields.routingKey, payload);
      ch.ack(msg);
    } catch (err) {
      console.error(`[${queueName}] handler failed, requeueing`, err);
      ch.nack(msg, false, true);
    }
  });
}
