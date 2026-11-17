import { Static, Type, TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { Event } from '@tak-ps/etl';
import { Feature } from '@tak-ps/node-cot';
import ETL, { SchemaType, handler as internal, local, DataFlowType, InvocationType } from '@tak-ps/etl';

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

const LeaseListItem = Type.Object({
    id: Type.Union([Type.Number(), Type.String()]),
    layer: Type.Optional(Type.Union([Type.Null(), Type.Number()])),
    source_id: Type.Optional(Type.Union([Type.Null(), Type.String()]))
});

const LeaseList = Type.Object({
    items: Type.Array(LeaseListItem),
    total: Type.Number()
});

const HLSLease = Type.Object({
    protocols: Type.Object({
        hls: Type.Object({
            url: Type.String()
        })
    })
});

const OutputSchema = Type.Object({
    camera_id: Type.String(),
    cloud_retention: Type.Integer(),
    date_added: Type.Integer(),
    device_retention: Type.Union([Type.Null(), Type.Integer()]),
    firmware: Type.String(),
    firmware_update_schedule: Type.String(),
    last_online: Type.Integer(),
    local_ip: Type.Union([Type.Null(), Type.String()]),
    location: Type.String(),
    location_angle: Type.Number(),
    location_lat: Type.Number(),
    location_lon: Type.Number(),
    mac: Type.Union([Type.Null(), Type.String()]),
    model: Type.String(),
    name: Type.String(),
    people_history_enabled: Type.Boolean(),
    serial: Type.String(),
    site: Type.String(),
    site_id: Type.String(),
    status: Type.String(),
    timezone: Type.String(),
    vehicle_history_enabled: Type.Boolean()
});

export default class Task extends ETL {
    static name = 'etl-verkada'
    static flow = [ DataFlowType.Incoming ];
    static invocation = [ InvocationType.Schedule ];

    async schema(
        type: SchemaType = SchemaType.Input,
        flow: DataFlowType = DataFlowType.Incoming
    ): Promise<TSchema> {
        if (flow !== DataFlowType.Incoming) return Type.Object({});

        return type === SchemaType.Input ? InputSchema : OutputSchema;
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


        let next_page_token: string | undefined = undefined;

        const features: Static<typeof Feature.InputFeature>[] = [];
        const cameras: Array<{
            camera: Static<typeof OutputSchema>,
            feature: Static<typeof Feature.InputFeature>
        }> = [];

        const leaseMap: Map<string, Static<typeof LeaseListItem>> = new Map();

        let leases: Static<typeof LeaseList>;
        let page = 0;
        do {
            const body: unknown = await this.fetch(`/api/connection/${layer.connection}/video/lease?limit=50&page=${page}`);
            if (!Value.Check(LeaseList, body)) throw new Error('Unexpected Video Lease List response');
            leases = body;

            for (const lease of leases.items) {
                if (lease.layer === layer.id && lease.source_id) {
                    leaseMap.set(lease.source_id, lease);
                }
            }
            ++page;
        } while (leases.total > 50 * page)

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
            if (next_page_token) devicesReqURL.searchParams.append('next_page_token', next_page_token);

            const devicesReq = await fetch(devicesReqURL, {
                method: 'GET',
                headers: {
                    'x-verkada-auth': token
                },
            });

            const res = await devicesReq.typed(Type.Object({
                cameras: Type.Array(OutputSchema),
                next_page_token: Type.Optional(Type.Union([Type.Null(), Type.String()]))
            }), { verbose: true } );

            // Verkada returns next_page_token as a string ("2", "3", ...) and null/absent on the final page.
            // Only continue paging while the token advances; otherwise stop to avoid an infinite loop.
            if (res.next_page_token && res.next_page_token !== next_page_token) {
                next_page_token = res.next_page_token;
            } else {
                next_page_token = undefined;
            }

            for (const camera of res.cameras) {
                const feat: Static<typeof Feature.InputFeature> = {
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
                cameras.push({ camera, feature: feat });
            }
        } while (next_page_token)

        const streamableCameras: Set<string> = new Set();

        // Process 20 api calls at a time
        for (let i = 0; i < cameras.length; i += 20) {
            const batch = cameras.slice(i, i + 20);

            const promises = [];

            for (const { camera, feature } of batch) {
                if (
                    streamToken.accessibleSites.includes(camera.site_id)
                    || streamToken.accessibleCameras.includes(camera.camera_id)
                ) {
                    promises.push((async () => {
                        streamableCameras.add(camera.camera_id);

                        const proxyURL = new URL(`https://${env.API_Region}.verkada.com/stream/cameras/v1/footage/stream/stream.m3u8`);
                        proxyURL.searchParams.append('start_time', '0');
                        proxyURL.searchParams.append('end_time', '0');
                        proxyURL.searchParams.append('codec', 'hevc');
                        proxyURL.searchParams.append('resolution', 'high_res');
                        proxyURL.searchParams.append('type', 'stream');
                        proxyURL.searchParams.append('transcode', 'false');

                        proxyURL.searchParams.append('jwt', streamToken.jwt);
                        proxyURL.searchParams.append('camera_id', camera.camera_id);
                        proxyURL.searchParams.append('org_id', env.API_ORG_ID);

                        const existingLease = leaseMap.get(camera.camera_id);
                        const leaseURL = existingLease
                            ? `/api/connection/${layer.connection}/video/lease/${existingLease.id}`
                            : `/api/connection/${layer.connection}/video/lease`;

                        const lease: unknown = await this.fetch(leaseURL, {
                            method: existingLease ? 'PATCH' : 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                            },
                            body: JSON.stringify({
                                name: camera.name,
                                duration: 3600,
                                source_id: camera.camera_id,
                                source_type: 'fixed',
                                source_model: `Verkada ${camera.model}`,
                                proxy: String(proxyURL),
                            })
                        });

                        if (Value.Check(HLSLease, lease)) {
                            feature.properties.video = {
                                url: lease.protocols.hls.url
                            }
                        }
                    })());
                }
            }

            // Errors in the promises are not surfaced
            await Promise.allSettled(promises);
        }

        const fc: Static<typeof Feature.InputFeatureCollection> = {
            type: 'FeatureCollection',
            features: features
        }

        await this.submit(fc);
    }
}

await local(await Task.init(import.meta.url), import.meta.url);
export async function handler(event: Event = {}): ReturnType<typeof internal> {
    return internal(await Task.init(import.meta.url), event);
}

