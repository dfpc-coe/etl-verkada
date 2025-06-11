import { Static, Type, TSchema } from '@sinclair/typebox';
import type { Event } from '@tak-ps/etl';
import ETL, { SchemaType, handler as internal, local, InputFeature, InputFeatureCollection, DataFlowType, InvocationType } from '@tak-ps/etl';

import { fetch } from '@tak-ps/etl';

const InputSchema = Type.Object({
    API_KEY: Type.String({
        description: 'API Token'
    }),
    DEBUG: Type.Boolean({
        default: false,
        description: 'Print results in logs'
    })
});

const OutputSchema = Type.Object({
});

export default class Task extends ETL {
    static name = 'etl-verkada'
    static flow = [ DataFlowType.Incoming ];
    static invocation = [ InvocationType.Schedule ];

    async schema(
        type: SchemaType = SchemaType.Input,
        flow: DataFlowType = DataFlowType.Incoming
    ): Promise<TSchema> {
        if (flow === DataFlowType.Incoming) {
            if (type === SchemaType.Input) {
                return InputSchema;
            } else {
                return OutputSchema;
            }
        } else {
            return Type.Object({});
        }
    }

    async control(): Promise<void> {
        const env = await this.env(InputSchema);

        const oauthReq = await fetch(`https://api.verkada.com/token`, {
            method: 'POST',
            headers: {
                'x-api-key': env.API_KEY
            }
        })

        const { token } = await oauthReq.typed(Type.Object({
            token: Type.String(),
        }));


        console.log('ok - requesting cameras');
        const next_page = false;

        do {
            const devicesReq = await fetch(`https://{region}.verkada.com/cameras/v1/devices`, {
                method: 'GET',
                headers: {
                    'x-verkada-auth': token
                },
            });

            await devicesReq.typed(Type.Object({

            }));

            const features: Static<typeof InputFeature>[] = [];

            const fc: Static<typeof InputFeatureCollection> = {
                type: 'FeatureCollection',
                features: features
            }

            await this.submit(fc);

        } while (next_page)
    }
}

await local(new Task(import.meta.url), import.meta.url);
export async function handler(event: Event = {}) {
    return await internal(new Task(import.meta.url), event);
}

