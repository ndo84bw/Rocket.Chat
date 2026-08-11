import type { IUser, PresenceStatusCode } from '@rocket.chat/core-typings';
import { UserStatus } from '@rocket.chat/core-typings';
import type { StreamerEvents } from '@rocket.chat/ddp-client';
import { Emitter } from '@rocket.chat/emitter';
import { Users } from '@rocket.chat/models';

import { Streamer } from '../../../../modules/streamer/streamer.module';
import type { IPublication, IStreamerConstructor, Connection, IStreamer } from '../../../../modules/streamer/types';
import { applyStatusVisibilityInvalidation, shouldHideStatus, warmStatusVisibility } from '../../../statusVisibilityChecker';

type UserPresenceStreamProps = {
	added: IUser['_id'][];
	removed: IUser['_id'][];
};

type UserPresenceStreamArgs = {
	uid: string;
	args: StreamerEvents['user-presence'][number]['args'];
};

const e = new Emitter<{
	[key: string]: UserPresenceStreamArgs;
}>();

export const STATUS_MAP: Record<UserStatus, PresenceStatusCode> = {
	[UserStatus.OFFLINE]: 0,
	[UserStatus.ONLINE]: 1,
	[UserStatus.AWAY]: 2,
	[UserStatus.BUSY]: 3,
	[UserStatus.DISABLED]: 0,
} as const;

const clients = new WeakMap<Connection, UserPresence>();

const active = new Set<UserPresence>();

class UserPresence {
	private readonly streamer: IStreamer<'user-presence'>;

	private readonly publication: IPublication;

	private readonly listeners: Set<string>;

	constructor(publication: IPublication, streamer: IStreamer<'user-presence'>) {
		this.listeners = new Set();
		this.publication = publication;
		this.streamer = streamer;
	}

	get viewerId(): string | undefined {
		return this.publication._session?.userId;
	}

	watches(uid: string): boolean {
		return this.listeners.has(uid);
	}

	listen(uid: string): void {
		if (this.listeners.has(uid)) {
			return;
		}
		e.on(uid, this.run);
		this.listeners.add(uid);
	}

	off = (uid: string): void => {
		e.off(uid, this.run);
		this.listeners.delete(uid);
	};

	run = (args: UserPresenceStreamArgs): void => {
		const viewerId = this.publication._session?.userId;
		const hidden = viewerId ? shouldHideStatus(viewerId, args.uid) : false;

		const emitted = hidden ? { ...args, args: [[args.args[0][0], STATUS_MAP[UserStatus.OFFLINE]] as const] } : args;

		const payload = this.streamer.changedPayload(this.streamer.subscriptionName, args.uid, { ...emitted, eventName: args.uid }); // there is no good explanation to keep eventName, I just want to save one 'DDPCommon.parseDDP' on the client side, so I'm trying to fit the Meteor Streamer's payload
		if (!payload) {
			return;
		}
		// after meteor 3.4.1 immediately after a disconnection session becomes null (which is not wrong)
		// we were just not counting on this, session is _session so we actually should not use it
		// now after any await, the session can potentially be null, so we need to check for that
		if (!Streamer.isPublicationActive(this.publication)) {
			return;
		}

		this.publication._session.socket.send(payload);
	};

	stop(): void {
		this.listeners.forEach(this.off);
		clients.delete(this.publication.connection);
		active.delete(this);

		const viewerId = this.publication._session?.userId;

		if (viewerId) {
			applyStatusVisibilityInvalidation({ viewers: [viewerId] });
		}
	}

	static getClient(publication: IPublication, streamer: IStreamer<'user-presence'>): [UserPresence, boolean] {
		const { connection } = publication;
		const stored = clients.get(connection);

		const client = stored || new UserPresence(publication, streamer);

		const main = Boolean(!stored);

		clients.set(connection, client);
		active.add(client);

		return [client, main];
	}
}

export class StreamPresence {
	// eslint-disable-next-line @typescript-eslint/naming-convention
	static getInstance(Streamer: IStreamerConstructor, name = 'user-presence'): IStreamer<'user-presence'> {
		return new (class StreamPresence extends Streamer<'user-presence'> {
			override async _publish(
				publication: IPublication,
				_eventName: string,
				options: boolean | { useCollection?: boolean; args?: any } = false,
			): Promise<void> {
				const { added, removed } = (typeof options !== 'boolean' ? options : {}) as unknown as UserPresenceStreamProps;

				const [client, main] = UserPresence.getClient(publication, this);

				const viewerId = publication._session?.userId;

				if (viewerId && added?.length) {
					await warmStatusVisibility(viewerId, added);
				}

				added?.forEach((uid) => client.listen(uid));
				removed?.forEach((uid) => client.off(uid));

				if (!main) {
					publication.stop();
					return;
				}

				publication.ready();

				publication.onStop(() => client.stop());
			}
		} as any)(name);
	}
}

export const emit = (uid: string, args: UserPresenceStreamArgs['args']): void => {
	e.emit(uid, { uid, args });
};

export const pushStatusVisibilityCorrection = async (uids: IUser['_id'][]): Promise<void> => {
	const watchers = [...active].filter((client) => uids.some((uid) => client.watches(uid)));

	if (!watchers.length) {
		return;
	}

	await Promise.all(
		[...new Set(watchers.map((client) => client.viewerId).filter(Boolean))].map((viewerId) =>
			warmStatusVisibility(viewerId as string, uids),
		),
	);

	const users = await Users.findByIds<Pick<IUser, '_id' | 'username' | 'status' | 'statusText' | 'statusSource' | 'statusExpiresAt'>>(
		uids,
		{
			projection: { username: 1, status: 1, statusText: 1, statusSource: 1, statusExpiresAt: 1 },
		},
	).toArray();

	for (const user of users) {
		if (!user.username) {
			continue;
		}

		emit(user._id, [
			[user.username, STATUS_MAP[user.status ?? UserStatus.OFFLINE], user.statusText, user.statusSource, user.statusExpiresAt],
		]);
	}
};
