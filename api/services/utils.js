/**
 * Constructs a description to be stored per ingress rule
 * Includes the expiration time along with the userKey and IP requested
 * Assumption: this description is never manually edited
 * @param {string} username
 * @param {string} userKey
 * @param {string} ipAddress
 * @param {number} durationHours expiration duration (in hours) for the ingress rule
  */
function getDescription(username, userKey, ipAddress, durationHours) {
  const createdAt = Date.now().valueOf();
  const expiresAt = createdAt + durationHours * 60 * 60 * 1000;
  const desc = `${username}, ${userKey}, ${createdAt}, ${expiresAt}, ${ipAddress}`;
  // console.log(desc);
  return desc;
}

/**
 * Parses back the Description string stored for an ingress rules.
 * @param {string} description Description of ingress rule containing expiration, userKey and IP info
 */
function parseDescription(description) {
  const [username, userKey, createdAt, expiresAt, ipAddress] = description.split(', ');
  const expired = Date.now().valueOf() > expiresAt;
  // const expired = true; // for testing
  // console.log(username, userKey, ipAddress, createdAt, expiresAt, expired);
  return { username, userKey, ipAddress, createdAt, expiresAt, expired };
}


module.exports = { 
  getDescription,
  parseDescription
};
