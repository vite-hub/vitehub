export function githubAuthorLogin(value: string | undefined): string | undefined {
  const login = value?.trim()
  return login && login.length <= 39 && /^[a-z\d](?:[a-z\d]|-(?=[a-z\d]))*(?:_[a-z\d]{3,8})?$/i.test(login) ? login : undefined
}
