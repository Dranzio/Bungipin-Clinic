// first and maybe only use is for forgot + reset pass in userController
module.exports = (err, req, res, next) => {
    err.statusCode = err.statusCode || 500;
    err.statys = err.status || "error";
    res.status(err.statusCode).json({
        status: err.status,
        message: err.message
    });
};