function validateName(name) {
  if (!name) return 'Name required';
  if (name.length > 20) return 'Name too long';
  return null;
}

module.exports = { validateName };
