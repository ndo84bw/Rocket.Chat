import { License } from '@rocket.chat/license';

import { notifyStatusVisibilityChanged } from '../lib/statusVisibilityChecker';
import { settings } from '../settings';

settings.watch('Accounts_StatusVisibility_Enabled', () => notifyStatusVisibilityChanged(), { debounce: 1000 });
settings.watch('Accounts_StatusVisibility_DefaultRoles', () => notifyStatusVisibilityChanged(), { debounce: 1000 });

for (const module of ['unlimited-presence', 'scalability'] as const) {
	void License.onValidFeature(module, () => notifyStatusVisibilityChanged());
	void License.onInvalidFeature(module, () => notifyStatusVisibilityChanged());
}
