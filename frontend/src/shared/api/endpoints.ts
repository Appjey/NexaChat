export const endpoints = {
  auth: {
    login: '/api/auth/login',
    register: '/api/auth/register',
    logout: '/api/auth/logout',
    changePassword: '/api/auth/password',
    me: '/api/auth/me',
    vault: '/api/auth/vault',
  },
  profile: (userId?: number | string) => (userId ? `/api/profile/${userId}` : '/api/profile'),
  chats: {
    list: '/api/chats',
    create: '/api/chats',
    delete: (chatId: number | string) => `/api/chats/${chatId}`,
    clear: (chatId: number | string) => `/api/chats/${chatId}/clear`,
    forward: (chatId: number | string) => `/api/chats/${chatId}/forward`,
    messages: (chatId: number | string) => `/api/chats/${chatId}/messages`,
    pin: (chatId: number | string, messageId: number | string) =>
      `/api/chats/${chatId}/messages/${messageId}/pin`,
    pins: (chatId: number | string) => `/api/chats/${chatId}/pins`,
  },
  contacts: {
    list: '/api/contacts',
    add: (userId: number | string) => `/api/contacts/${userId}`,
    remove: (userId: number | string) => `/api/contacts/${userId}`,
  },
  attachments: {
    upload: (chatId: number | string, messageId: number | string) =>
      `/api/chats/${chatId}/messages/${messageId}/attachments`,
    get: (id: number | string) => `/api/attachments/${id}`,
    remove: (id: number | string) => `/api/attachments/${id}`,
  },
  avatar: {
    upload: '/api/user/avatar',
    remove: '/api/user/avatar',
    get: (userId: number | string) => `/api/avatars/${userId}`,
  },
  groups: {
    create: '/api/groups',
    info: (groupId: number | string) => `/api/groups/${groupId}`,
    update: (groupId: number | string) => `/api/groups/${groupId}`,
    remove: (groupId: number | string) => `/api/groups/${groupId}`,
    addMembers: (groupId: number | string) => `/api/groups/${groupId}/members`,
    removeMember: (groupId: number | string, userId: number | string) =>
      `/api/groups/${groupId}/members/${userId}`,
    leave: (groupId: number | string) => `/api/groups/${groupId}/leave`,
    changeRole: (groupId: number | string, userId: number | string) =>
      `/api/groups/${groupId}/members/${userId}/role`,
    keys: (groupId: number | string) => `/api/groups/${groupId}/keys`,
    uploadAvatar: (groupId: number | string) => `/api/groups/${groupId}/avatar`,
    removeAvatar: (groupId: number | string) => `/api/groups/${groupId}/avatar`,
    getAvatar: (chatId: number | string) => `/api/group-avatars/${chatId}`,
  },
  presence: {
    get: (userId: number | string) => `/api/presence/${userId}`,
  },
  push: {
    vapidKey: '/api/push/vapid-key',
    subscribe: '/api/push/subscribe',
    unsubscribe: '/api/push/unsubscribe',
    status: '/api/push/status',
    fcmRegister: '/api/push/fcm/register',
    fcmUnregister: '/api/push/fcm/unregister',
  },
  ws: {
    global: '/ws',
  },
  updates: {
    latest: '/api/updates/latest',
  },
  clientErrors: '/api/client-errors',
}
