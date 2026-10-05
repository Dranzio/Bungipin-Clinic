// first and maybe only use is for forgot + reset pass in userController
module.exports = (err, req, res, next) => {
    // eli change: if a normal page load crashes, send the browser to the friendly error page instead of raw JSON
    if (req.method === 'GET' && !req.path.startsWith('/api') && req.accepts('html')) {
        return res.redirect('/missingPageError.html?from=' + encodeURIComponent(req.originalUrl));
    }
    err.statusCode = err.statusCode || 500;
    err.statys = err.status || "error";
    res.status(err.statusCode).json({
        status: err.status,
        message: err.message
    });
};