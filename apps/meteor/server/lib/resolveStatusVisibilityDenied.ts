import type { IUser } from '@rocket.chat/core-typings';
import { Users } from '@rocket.chat/models';

export const resolveStatusVisibilityDenied = async (usernames: string[]): Promise<IUser['_id'][]> => {
	if (!usernames.length) {
		return [];
	}

	const users = await Users.findByUsernames(usernames, { projection: { _id: 1 } }).toArray();

	return users.map(({ _id }) => _id);
};
