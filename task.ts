import { Static, Type, TSchema } from '@sinclair/typebox';
import type { Event, APITypes } from '@tak-ps/etl';
import ETL, { SchemaType, handler as internal, local, InputFeature, InputFeatureCollection, DataFlowType, InvocationType } from '@tak-ps/etl';

import { fetch } from '@tak-ps/etl';

const InputSchema = Type.Object({
    API_KEY: Type.String({
        description: 'API Token'
    }),
    API_ORG_ID: Type.String({
        description: 'Verkada Organization ID',
    }),
    API_Region: Type.String({
        default: 'api',
        enum: [
            'api',
            'api.eu',
            'api.au'
        ]
    }),
    DEBUG: Type.Boolean({
        default: false,
        description: 'Print results in logs'
    })
});

type LeaseList = APITypes.paths["/connection/{:connectionid}/video/lease"]["get"]["responses"]["200"]["content"]["application/json"];
type Lease = LeaseList['items'][0];

const OutputSchema = Type.Object({
    "camera_id": Type.String(),
    "cloud_retention": Type.Integer(),
    "date_added": Type.Integer(),
    "device_retention": Type.Union([Type.Null(), Type.Integer()]),
    "firmware": Type.String(),
    "firmware_update_schedule": Type.String(),
    "last_online": Type.Integer(),
    "local_ip": Type.Union([Type.Null(), Type.String()]),
    "location": Type.String(),
    "location_angle": Type.Number(),
    "location_lat": Type.Number(),
    "location_lon": Type.Number(),
    "mac": Type.Union([Type.Null(), Type.String()]),
    "model": Type.String(),
    "name": Type.String(),
    "people_history_enabled": Type.Boolean(),
    "serial": Type.String(),
    "site": Type.String(),
    "site_id": Type.String(),
    "status": Type.String(),
    "timezone": Type.String(),
    "vehicle_history_enabled": Type.Boolean()
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
        const layer = await this.fetchLayer();
        const env = await this.env(InputSchema);

        const oauthReq = await fetch(`https://${env.API_Region}.verkada.com/token`, {
            method: 'POST',
            headers: {
                'x-api-key': env.API_KEY
            }
        })

        const { token } = await oauthReq.typed(Type.Object({
            token: Type.String(),
        }));


        let next_page_token: number | undefined = undefined;

        const features: Static<typeof InputFeature>[] = [];

        const leases = await this.fetch(`/api/connection/${this.layer.connection}/video/lease`) as LeaseList;

        const streamTokenReqURL = new URL(`https://${env.API_Region}.verkada.com/cameras/v1/footage/token`)
        const streamTokenReq = await fetch(streamTokenReqURL, {
            headers: { 'x-api-key': env.API_KEY }
        })

        const streamToken = await streamTokenReq.typed(Type.Object({
            accessibleCameras: Type.Array(Type.String()),
            accessibleSites: Type.Array(Type.String()),
            expiration: Type.Integer(),
            expiresAt: Type.Integer(),
            jwt: Type.String(),
            permission: Type.Array(Type.String())
        }))

        do {
            console.log('ok - requesting cameras - ', next_page_token ? `page: ${next_page_token}` : "page: 1");
            const devicesReqURL = new URL(`https://${env.API_Region}.verkada.com/cameras/v1/devices`)
            if (next_page_token) devicesReqURL.searchParams.append('next_page_token', String(next_page_token));

            const devicesReq = await fetch(devicesReqURL, {
                method: 'GET',
                headers: {
                    'x-verkada-auth': token
                },
            });

            const res = await devicesReq.typed(Type.Object({
                cameras: Type.Array(OutputSchema),
                next_page_token: Type.Optional(Type.Integer())
            }), { verbose: true } );

            if (res.next_page_token !== next_page_token) {
                next_page_token = res.next_page_token;
            } else {
                next_page_token = undefined;
            }

            for (const camera of res.cameras) {
                const feat: Static<typeof InputFeature> = {
                    id: camera.camera_id,
                    type: 'Feature',
                    properties: {
                        type: 'b-m-p-s-p-loc',
                        how: 'm-g',
                        callsign: camera.name,
                        course: camera.location_angle,
                        sensor: {
                            range: 50,
                            azimuth: camera.location_angle,
                            type: 'Verkada',
                            model: camera.model
                        },
                        remarks: [
                            ''
                        ].join(','),
                        metadata: camera
                    },
                    geometry: {
                        type: 'Point',
                        coordinates: [ camera.location_lon, camera.location_lat ]
                    }
                }

                features.push(feat);
            }
        } while (next_page_token)

        const leaseMap: Map<string, Lease> = new Map();

        for (const lease of leases.items) {
            if (lease.layer === layer.id && lease.source_id) {
                leaseMap.set(lease.source_id, lease);
            }
        }

        const streamableCameras: Set<string> = new Set();
        for (const feature of features) {
            const metadata = feature.properties.metadata as Static<typeof OutputSchema>;

            if (
                streamToken.accessibleSites.includes(metadata.site_id)
                || streamToken.accessibleCameras.includes(metadata.camera_id)
            ) {
                streamableCameras.add(metadata.camera_id);

                 const proxyURL = new URL(`https://${env.API_Region}.verkada.com/stream/cameras/v1/footage/stream/key`);
                 proxyURL.searchParams.append('start_time', '0');
                 proxyURL.searchParams.append('end_time', '0');
                 proxyURL.searchParams.append('codec', 'hevc');
                 proxyURL.searchParams.append('resolution', 'low_res');
                 proxyURL.searchParams.append('type', 'stream');
                 proxyURL.searchParams.append('transcode', 'false');

                console.error('STREAMING URL', String(proxyURL));

                const existingLease = leaseMap.get(metadata.camera_id);
                if (existingLease) {
                    await this.fetch(`/api/connection/${this.layer.connection}/video/lease/${existingLease.id}`, {
                        method: 'PATCH',
                        body: JSON.stringify({
                            name: metadata.name,
                            permanent: true,
                            source_id: metadata.camera_id,
                            source_type: 'Verkada',
                            source_model: metadata.model,
                            proxy: String(proxyURL),
                        })
                    });
                } else {
                    await this.fetch(`/api/connection/${this.layer.connection}/video/lease`, {
                        method: 'POST',
                        body: JSON.stringify({
                            name: metadata.name,
                            permanent: true,
                            source_id: metadata.camera_id,
                            source_type: 'Verkada',
                            source_model: metadata.model,
                            proxy: String(proxyURL),
                        })
                    });
                }
            }
        }

        const fc: Static<typeof InputFeatureCollection> = {
            type: 'FeatureCollection',
            features: features
        }

        return;
        await this.submit(fc);
    }
}

await local(await Task.init(import.meta.url), import.meta.url);
export async function handler(event: Event = {}) {
    return await internal(await Task.init(import.meta.url), event);
}

