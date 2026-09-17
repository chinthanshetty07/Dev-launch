// Fails the way real applications do when configuration is absent.
const token = process.env.REQUIRED_TOKEN;
if (!token) {
  console.error('Error: Missing required environment variable REQUIRED_TOKEN');
  process.exit(1);
}
console.log('would start here');
